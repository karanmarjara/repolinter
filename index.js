// Copyright 2017 TODO Group. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const jsonfile = require('jsonfile')
const ajv = require('ajv');
const path = require('path')
const fs = require('fs')
const findConfig = require('find-config')
const Result = require('./lib/result')
const RuleInfo = require('./lib/ruleinfo')
const FormatResult = require('./lib/formatresult')
const FileSystem = require('./lib/file_system')

/**
 * @typedef {object} Formatter
 * 
 * @property {(result: FormatResult, dryRun: boolean) => string} [formatResult] A function to format a single FormatResult into a line of text
 * @property {(output: LintResult, dryRun: boolean) => string} formatOutput A function to format the entire linter output
 */

/** @type {Formatter} */
module.exports.defaultFormatter = require('./formatters/symbol_formatter')
/** @type {Formatter} */
module.exports.jsonFormatter = require('./formatters/json_formatter')
/** @type {Formatter} */
module.exports.resultFormatter = exports.defaultFormatter

/**
 * @typedef {object} LintResult
 * 
 * @property {{ targetDir: string, filterPaths: string[], rulesetPath?: string, ruleset: object }} params 
 * The parameters to the lint function call, including the found/supplied ruleset object.
 * @property {boolean} passed Whether or not all lint rules and fix rules succeeded. Will be false if an error occurred during linting.
 * @property {boolean} errored Whether or not an error occurred during the linting process (ex. the configuration failed validation).
 * @property {string} [errMsg] A string indication error information, will be present if errored is true.
 * @property {FormatResult[]} results The output of all the linter rules.
 * @property {string[]} targets The array of axiom targets which the target repository satisfied.
 */

/**
 * An exposed function for the repolinter engine. Use this function
 * to run repolinter on a specified directory targetDir. You can
 * also optionally specify which paths to allowlist (filterPaths),
 * whether or not to actually commit modifications (fixes), and 
 * a custom ruleset object to use.
 * 
 * @param {string} targetDir The directory of the repository to lint.
 * @param {string[]} filterPaths A list of directories to allow linting of, or [] for all.
 * @param {boolean} dryRun If true, repolinter will report suggested fixes, but will make no disk modifications.
 * @param {object|string|null} ruleset A custom ruleset object with the same structure as the JSON ruleset configs, or a string path to a JSON config.
 * Set to null for repolinter to automatically find it in the repository.
 * @returns {LintResult} An object representing the output of the linter
 */
function lint(targetDir, filterPaths = [], dryRun = false, ruleset = null) {
  // TODO: Rework cli interface to use new API (fix incorrect command?)
  // TODO: Rework format to have a "fix" section
  // TODO: Fix rule level with exit code and formatting
  // TODO: Dry run? Report generation?
  // TODO: Fix fixes
  // TODO: Fix tests to work with new rule format
  // TODO: More tests
  // TODO: rewrite formatters (1 of 2)
  // TODO: write markdown formatter

  const fileSystem = new FileSystem()
  fileSystem.targetDir = targetDir
  if (filterPaths.length > 0) 
    fileSystem.filterPaths = filterPaths

  let rulesetPath
  if (typeof ruleset === 'string') {
    rulesetPath = ruleset
    ruleset = jsonfile.readFileSync(ruleset)
  } 
  else if (!ruleset) {
    rulesetPath = findConfig('repolint.json', { cwd: targetDir })
    rulesetPath = rulesetPath || findConfig('repolinter.json', { cwd: targetDir })
    rulesetPath = rulesetPath || path.join(__dirname, 'rulesets/default.json')
    ruleset = jsonfile.readFileSync(rulesetPath)
  }

  // validate config
  const val = validateConfig(ruleset)
  if (!val.passed) {
    return {
      params: {
        targetDir,
        filterPaths,
        rulesetPath,
        ruleset,
      },
      passed: false,
      errored: true,
      /** @ts-ignore */
      errMsg: val.error,
      results: [],
      targets: [],
    }
  }

  // determine axiom targets
  let targets = []
  // Identify axioms and execute them
  if (ruleset.axioms)
    targets = determineTargets(ruleset.axioms, fileSystem)
  
  // execute ruleset
  const result = runRuleset(ruleset, targets, fileSystem)

  const passed = result.filter(r => 
    r.status === FormatResult.ERROR || 
    (r.status !== FormatResult.IGNORED && !r.lintResult.passed)).length === 0

  // render all the results
  const all_format_info = {
    params: {
      targetDir,
      filterPaths,
      rulesetPath,
      ruleset,
    },
    passed,
    errored: false,
    results: result,
    targets,
  }  

  return all_format_info
}

/**
 * Run all operations in a ruleset, including linting and fixing. Returns
 * a list of objects with the output of the linter rules
 * 
 * @param {{ axioms: string[], rules: object }} ruleset A ruleset configuration conforming to {@link ../rulesets/schema.json}
 * @param {string[]|true} targets The axiom targets to enable for this run of the ruleset (ex. "language=javascript"). or true for all
 * @param {FileSystem} fileSystem A filesystem object configured with filter paths and a target directory.
 * @param {string} self_dir The path containing the source files for the currently running linter instance
 * @returns {FormatResult[]} Objects indicating the result of the linter rules
 */
function runRuleset(ruleset, targets, fileSystem, self_dir = __dirname) {
  return Object.entries(ruleset.rules)
    // compile the ruleset into RuleInfo objects
    .map(([name, cfg]) => 
      new RuleInfo(
        name, 
        cfg.level, 
        cfg.where, 
        cfg.rule.type, 
        cfg.rule.options, 
        cfg.fix && cfg.fix.type, 
        cfg.fix && cfg.fix.options
      ))
    // Execute all rule targets
    .map(r => {
      // check axioms and enable appropriately
      if (r.level === "off")
        return FormatResult.CreateIgnored(r, `ignored because level is "off"`)
      // filter to only targets with no matches
      if (targets !== true) {
        const ignoreReasons = r.where.filter(check => !targets.find(tar => check === tar))
        if (ignoreReasons.length > 0)
          return FormatResult.CreateIgnored(r, `ignored due to unsatisfied condition(s): "${ ignoreReasons.join('", "') }"`)
      }
      // check if the rule file exists
      const ruleFile = path.join(self_dir, 'rules', r.ruleType)
      if (!fs.existsSync(ruleFile + '.js'))
        return FormatResult.CreateError(r, `${ ruleFile } does not exist`)
      let result
      try {
        /** @type {(fs: FileSystem, options: object) => Result} */
        const ruleFunc = require(ruleFile)
        // run the rule!
        result = ruleFunc(fileSystem, r.ruleConfig)
      }
      catch (e) {
        return FormatResult.CreateError(r, `${ r.ruleType } threw an error: ${ e.message }`)
      }
      // generate fix targets
      const fixTargets = result.targets.filter(t => !t.passed).map(t => t.path)
      // if there's no fix or the rule passed, we're done
      if (!r.fixType || result.passed)
        return FormatResult.CreateLintOnly(r, result)
      // else run the fix
      const fixFile = path.join(self_dir, 'fixes', r.fixType)
      if (!fs.existsSync(ruleFile + '.js'))
        return FormatResult.CreateError(r, `${ fixFile } does not exist`)
      let fixresult
      try {
        // TODO: dry run?
        /** @type {(fs: FileSystem, options: object, targets: string[]) => Result} */
        const fixFunc = require(fixFile)
        fixresult = fixFunc(fileSystem, r.fixConfig, fixTargets)
      }
      catch (e) {
        return FormatResult.CreateError(r, `${ r.fixType } threw an error: ${ e.message }`)
      }
      // all done! return the final format object
      return FormatResult.CreateLintAndFix(r, result, fixresult)
    })
}

/**
 * Given an axiom configuration, determine the appropriate targets to run against
 * (e.g. "target=javascript").
 * 
 * @param {object} axiomconfig A configuration conforming to the "axioms" section in schema.json
 * @param {FileSystem} fs The filesystem to run axioms against
 * @param {string} self_dir The path containing the source files for the currently running linter instance
 * @returns {string[]} A list of targets to run against
 */
function determineTargets(axiomconfig, fs, self_dir = __dirname) {
  return Object.entries(axiomconfig)
    .map(([axiomId, axiomName]) => {
      // TODO: Do something more secure
      // Execute axiom
      const axiomFunction = require(path.join(self_dir, 'axioms', axiomId))
      return [`${ axiomName }=*`].concat(axiomFunction(fs).map(axiomOutput => `${ axiomName }=${ axiomOutput }`))
    })
    .reduce((a, v) => a.concat(v), [])
}

/**
 * Validate a repolint configuration against a known JSON schema
 * 
 * @param {object} config The configuration to validate
 * @param {string} self_dir The path containing the source files for the currently running linter instance
 * @returns {{ passed: false, error: string } | { passed: true }} Whether or not the config validation succeeded
 */
function validateConfig(config, self_dir = __dirname) {
  // compile the json schema
  const ajv_props = new ajv()
  const fs = new FileSystem(self_dir)
  // FIXME: cannot use fileSystem here because the target directory is wrong
  for (const schema of fs.findAllFiles(["rules/*-config.json", "fixes/*-config.json"], true))
    ajv_props.addSchema(jsonfile.readFileSync(schema))
  const validator = ajv_props.compile(jsonfile.readFileSync('./rulesets/schema.json'))

  // validate it against the supplied ruleset
  if (!validator(config))
    return {
      passed: false,
      error: `Configuration validation failed with errors: \n${ validator.errors.map(e => `\tconfiguration${ e.dataPath } ${ e.message }`).join('\n') }`
    }
  else
    return { passed: true }
}

exports.runRuleset = runRuleset
exports.determineTargets = determineTargets
exports.validateConfig = validateConfig
exports.lint = lint;