// Copyright 2017 TODO Group. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const spawnSync = require('child_process').spawnSync
const Result = require('../lib/result')
const FileSystem = require ('../lib/file_system')

function grepLog (fileSystem, options) {
  const args = ['-C', fileSystem.targetDir, 'log', '--all', '--format=full', '-E']
    .concat(options.blacklist.map(pattern => `--grep=${pattern}`))
  if (options.ignoreCase) {
    args.push('-i')
  }
  const log = spawnSync('git', args).stdout.toString()
  return parseLog(log)
}

function parseLog (log) {
  const logEntries = log.split('\ncommit ').filter(x => !!x)

  return logEntries.map(entry => extractInfo(entry))
}

function extractInfo (commit) {
  const [hash, , , ...message] = commit.split('\n')
  return {
    hash: hash.split(' ')[1],
    message: message.join('\n')
  }
}

/**
 * 
 * @param {FileSystem} fs A filesystem object configured with filter paths and target directories
 * @param {object} options The rule configuration
 * @returns {Result} The lint rule result
 */
function gitGrepLog(fs, options) {
  const commits = grepLog(fs, options)

  const targets = commits.map(commit => {
    const message = [
      `The commit message for commit ${commit.hash.substr(0, 7)} contains blacklisted words.\n`,
      `\tBlacklist: ${options.blacklist.join(', ')}`
    ].join('\n')

    return {
      passed: false,
      message,
      path: commit
    }
  })

  if (targets.length === 0) {
    const message = `No blacklisted words found in any commit messages.\n\tBlacklist: ${options.blacklist.join(', ')}`
    return new Result(message, [], true)
  }

  return new Result('', targets, false)
}

module.exports = gitGrepLog