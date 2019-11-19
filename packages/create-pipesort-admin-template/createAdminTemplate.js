/**
 * Copyright (c) 2019, Pipesort, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const chalk = require('chalk');
const commander = require('commander');
const dns = require('dns');
const envinfo = require('envinfo');
const execSync = require('child_process').execSync;
const fs = require('fs-extra');
const hyperquest = require('hyperquest');
const os = require('os');
const path = require('path');
const semver = require('semver');
const spawn = require('cross-spawn');
const tmp = require('tmp');
const unpack = require('tar-pack').unpack;
const url = require('url');
const validateProjectName = require('validate-npm-package-name');

const packageJson = require('./package.json');

// These files should be allowed to remain on a failed install,
// but then silently removed during the next create.
const errorLogFilePatterns = [
  'npm-debug.log',
  'yarn-error.log',
  'yarn-debug.log',
];

let projectName;

const program = new commander.Command(packageJson.name)
  .version(packageJson.version)
  .arguments('<project-directory>')
  .usage(`${chalk.green('<project-directory>')} [options]`)
  .action(name => {
    projectName = name;
  })
  .option('--verbose', 'print additional logs')
  .option('--info', 'print environment debug info')
  .option(
    '--template <path-to-template>',
    'specify a template for the created project'
  )
  .option('--use-npm')
  .option('--use-pnp')
  .allowUnknownOption()
  .on('--help', () => {
    console.log(`    Only ${chalk.green('<project-directory>')} is required.`);
    console.log();
    console.log();
  })
  .parse(process.argv);

if (program.info) {
  console.log(chalk.bold('\nEnvironment Info:'));
  return envinfo
    .run(
      {
        System: ['OS', 'CPU'],
        Binaries: ['Node', 'npm', 'Yarn'],
        Browsers: ['Chrome', 'Edge', 'Internet Explorer', 'Firefox', 'Safari'],
        npmPackages: [],
        npmGlobalPackages: ['create-pipesort-admin-template'],
      },
      {
        duplicates: true,
        showNotFound: true,
      }
    )
    .then(console.log);
}

if (typeof projectName === 'undefined') {
  console.error('Please specify the project directory:');
  console.log(
    `  ${chalk.cyan(program.name())} ${chalk.green('<project-directory>')}`
  );
  console.log();
  console.log('For example:');
  console.log(`  ${chalk.cyan(program.name())} ${chalk.green('my-admin-app')}`);
  console.log();
  console.log(
    `Run ${chalk.cyan(`${program.name()} --help`)} to see all options.`
  );
  process.exit(1);
}

function printValidationResults(results) {
  if (typeof results !== 'undefined') {
    results.forEach(error => {
      console.error(chalk.red(`  *  ${error}`));
    });
  }
}

createApp(
  projectName,
  program.verbose,
  program.template,
  program.useNpm,
  program.usePnp
);

function createApp(name, verbose, template, useNpm, usePnp) {
  const unsupportedNodeVersion = !semver.satisfies(process.version, '>=8.10.0');

  if (unsupportedNodeVersion) {
    console.log(
      chalk.yellow(
        `You are using Node ${process.version} which is not supported.\n\n` +
          `Please update to Node 8.10 or higher.\n`
      )
    );

    process.exit(1);
  }

  const root = path.resolve(name);
  const appName = path.basename(root);

  checkAppName(appName);
  fs.ensureDirSync(name);
  if (!isSafeToCreateProjectIn(root, name)) {
    process.exit(1);
  }

  console.log(
    `Creating a new Pipesort Admin Template in ${chalk.green(root)}.`
  );
  console.log();

  const useYarn = useNpm ? false : shouldUseYarn();
  const originalDirectory = process.cwd();
  process.chdir(root);
  if (!useYarn && !checkThatNpmCanReadCwd()) {
    process.exit(1);
  }

  if (!useYarn) {
    const npmInfo = checkNpmVersion();
    if (!npmInfo.hasMinNpm) {
      if (npmInfo.npmVersion) {
        console.log(
          chalk.yellow(
            `You are using npm ${npmInfo.npmVersion} which is not supported.\n\n` +
              `Please update to npm 5 or higher for a better, fully supported experience.\n`
          )
        );
      }

      process.exit(1);
    }
  } else if (usePnp) {
    const yarnInfo = checkYarnVersion();
    if (!yarnInfo.hasMinYarnPnp) {
      if (yarnInfo.yarnVersion) {
        console.log(
          chalk.yellow(
            `You are using Yarn ${yarnInfo.yarnVersion} together with the --use-pnp flag, but Plug'n'Play is only supported starting from the 1.12 release.\n\n` +
              `Please update to Yarn 1.12 or higher for a better, fully supported experience.\n`
          )
        );
      }
      // 1.11 had an issue with webpack-dev-middleware, so better not use PnP with it (never reached stable, but still)
      usePnp = false;
    }
  }

  if (useYarn) {
    let yarnUsesDefaultRegistry = true;
    try {
      yarnUsesDefaultRegistry =
        execSync('yarnpkg config get registry')
          .toString()
          .trim() === 'https://registry.yarnpkg.com';
    } catch (e) {
      // ignore
    }
    if (yarnUsesDefaultRegistry) {
      // fs.copySync(
      //   require.resolve('./yarn.lock.cached'),
      //   path.join(root, 'yarn.lock')
      // );
    }
  }

  run(root, appName, verbose, originalDirectory, template, useYarn, usePnp);
}

function shouldUseYarn() {
  try {
    execSync('yarnpkg --version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function install(root, useYarn, usePnp, dependencies, verbose, isOnline) {
  return new Promise((resolve, reject) => {
    let command;
    let args;
    if (useYarn) {
      command = 'yarnpkg';
      args = ['add', '--exact'];
      if (!isOnline) {
        args.push('--offline');
      }
      if (usePnp) {
        args.push('--enable-pnp');
      }
      [].push.apply(args, dependencies);

      // Explicitly set cwd() to work around issues like
      // https://github.com/facebook/create-react-app/issues/3326.
      // Unfortunately we can only do this for Yarn because npm support for
      // equivalent --prefix flag doesn't help with this issue.
      // This is why for npm, we run checkThatNpmCanReadCwd() early instead.
      args.push('--cwd');
      args.push(root);

      if (!isOnline) {
        console.log(chalk.yellow('You appear to be offline.'));
        console.log(chalk.yellow('Falling back to the local Yarn cache.'));
        console.log();
      }
    } else {
      command = 'npm';
      args = [
        'install',
        '--save',
        '--save-exact',
        '--loglevel',
        'error',
      ].concat(dependencies);

      if (usePnp) {
        console.log(chalk.yellow("NPM doesn't support PnP."));
        console.log(chalk.yellow('Falling back to the regular installs.'));
        console.log();
      }
    }

    if (verbose) {
      args.push('--verbose');
    }

    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('close', code => {
      if (code !== 0) {
        reject({
          command: `${command} ${args.join(' ')}`,
        });
        return;
      }
      resolve();
    });
  });
}

function isInGitRepository() {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function isInMercurialRepository() {
  try {
    execSync('hg --cwd . root', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function tryGitInit(appPath) {
  let didInit = false;
  try {
    execSync('git --version', { stdio: 'ignore' });
    if (isInGitRepository() || isInMercurialRepository()) {
      return false;
    }

    execSync('git init', { stdio: 'ignore' });
    didInit = true;

    execSync('git add -A', { stdio: 'ignore' });
    execSync(
      'git commit -m "Initial commit from Create-Pipesort-Admin-Template"',
      {
        stdio: 'ignore',
      }
    );
    return true;
  } catch (e) {
    if (didInit) {
      // If we successfully initialized but couldn't commit,
      // maybe the commit author config is not set.
      // In the future, we might supply our own committer
      // like Ember CLI does, but for now, let's just
      // remove the Git files to avoid a half-done state.
      try {
        // unlinkSync() doesn't work on directories.
        fs.removeSync(path.join(appPath, '.git'));
      } catch (removeErr) {
        // Ignore.
      }
    }
    return false;
  }
}

function init(appPath, appName, verbose, originalDirectory, templateName) {
  console.log();

  const useYarn = fs.existsSync(path.join(appPath, 'yarn.lock'));

  if (!templateName) {
    console.log('');
    console.error(`A template was not provided.`);
    return;
  }

  const templatePath = path.join(
    require.resolve(templateName, { paths: [appPath] }),
    '..'
  );

  // Copy the files for the user
  const templateDir = path.join(templatePath, 'template');
  if (fs.existsSync(templateDir)) {
    fs.copySync(templateDir, appPath);
  } else {
    console.error(
      `Could not locate supplied template: ${chalk.green(templateDir)}`
    );
    return;
  }

  // Rename gitignore after the fact to prevent npm from renaming it to .npmignore
  // See: https://github.com/npm/npm/issues/1862
  try {
    fs.moveSync(
      path.join(appPath, 'gitignore'),
      path.join(appPath, '.gitignore'),
      []
    );
  } catch (err) {
    // Append if there's already a `.gitignore` file there
    if (err.code === 'EEXIST') {
      const data = fs.readFileSync(path.join(appPath, 'gitignore'));
      fs.appendFileSync(path.join(appPath, '.gitignore'), data);
      fs.unlinkSync(path.join(appPath, 'gitignore'));
    } else {
      throw err;
    }
  }

  let command;
  let remove;
  let args;

  if (useYarn) {
    command = 'yarnpkg';
    remove = 'remove';
    args = ['add'];
  } else {
    command = 'npm';
    remove = 'uninstall';
    args = ['install', '--save', verbose && '--verbose'].filter(e => e);
  }

  // Install additional template dependencies, if present
  let templateJsonPath;
  if (templateName) {
    templateJsonPath = path.join(templatePath, 'template.json');
  } else {
    templateJsonPath = path.join(appPath, '.template.dependencies.json');
  }

  if (fs.existsSync(templateJsonPath)) {
    const templateDependencies = require(templateJsonPath).dependencies;
    args = args.concat(
      Object.keys(templateDependencies).map(key => {
        return `${key}@${templateDependencies[key]}`;
      })
    );
    fs.unlinkSync(templateJsonPath);
  }

  // Remove template
  console.log(`Removing template package using ${command}...`);
  console.log();

  const proc = spawn.sync(command, [remove, templateName], {
    stdio: 'inherit',
  });
  if (proc.status !== 0) {
    console.error(`\`${command} ${args.join(' ')}\` failed`);
    return;
  }

  if (tryGitInit(appPath)) {
    console.log();
    console.log('Initialized a git repository.');
  }

  // Display the most elegant way to cd.
  // This needs to handle an undefined originalDirectory for
  // backward compatibility with old global-cli's.
  let cdpath;
  if (originalDirectory && path.join(originalDirectory, appName) === appPath) {
    cdpath = appName;
  } else {
    cdpath = appPath;
  }

  // Change displayed command to yarn instead of yarnpkg
  const displayedCommand = useYarn ? 'yarn' : 'npm';

  console.log();
  console.log(`Success! Created ${appName} at ${appPath}`);
  console.log('Inside that directory, you can run several commands:');
  console.log('We suggest that you begin by typing:');
  console.log();
  console.log(chalk.cyan('  cd'), cdpath);
  console.log(`  ${chalk.cyan(`${displayedCommand} start`)}`);
  console.log();
}

function run(
  root,
  appName,
  verbose,
  originalDirectory,
  template,
  useYarn,
  usePnp
) {
  Promise.all([getTemplateInstallPackage(template, originalDirectory)]).then(
    ([templateToInstall]) => {
      const allDependencies = [templateToInstall];

      Promise.all([getPackageInfo(templateToInstall)])
        .then(([templateInfo]) =>
          checkIfOnline(useYarn).then(isOnline => ({
            isOnline,
            templateInfo,
          }))
        )
        .then(({ isOnline, templateInfo }) => {
          return install(
            root,
            useYarn,
            usePnp,
            allDependencies,
            verbose,
            isOnline
          ).then(() => ({
            templateInfo,
          }));
        })
        .then(async ({ templateInfo }) => {
          const templateName = templateInfo.name;

          const pnpPath = path.resolve(process.cwd(), '.pnp.js');

          const nodeArgs = fs.existsSync(pnpPath) ? ['--require', pnpPath] : [];

          init(root, appName, verbose, originalDirectory, templateName);

          await executeNodeScript(
            {
              cwd: process.cwd(),
              args: nodeArgs,
            },
            [root, appName, verbose, originalDirectory, templateName],
            `
            var init = require('./init');
            init.apply(null, JSON.parse(process.argv[1]));
          `
          );
        })
        .catch(reason => {
          console.log();
          console.log('Aborting installation.');
          if (reason.command) {
            console.log(`  ${chalk.cyan(reason.command)} has failed.`);
          } else {
            console.log(
              chalk.red('Unexpected error. Please report it as a bug:')
            );
            console.log(reason);
          }
          console.log();

          // On 'exit' we will delete these files from target directory.
          const knownGeneratedFiles = [
            'package.json',
            'yarn.lock',
            'node_modules',
          ];
          const currentFiles = fs.readdirSync(path.join(root));
          currentFiles.forEach(file => {
            knownGeneratedFiles.forEach(fileToMatch => {
              // This removes all knownGeneratedFiles.
              if (file === fileToMatch) {
                console.log(`Deleting generated file... ${chalk.cyan(file)}`);
                fs.removeSync(path.join(root, file));
              }
            });
          });
          const remainingFiles = fs.readdirSync(path.join(root));
          if (!remainingFiles.length) {
            // Delete target folder if empty
            console.log(
              `Deleting ${chalk.cyan(`${appName}/`)} from ${chalk.cyan(
                path.resolve(root, '..')
              )}`
            );
            process.chdir(path.resolve(root, '..'));
            fs.removeSync(path.join(root));
          }
          console.log('Done.');
          process.exit(1);
        });
    }
  );
}

function getTemplateInstallPackage(template, originalDirectory) {
  let templateToInstall = 'pipesort-admin-template';
  if (template) {
    if (template.match(/^file:/)) {
      templateToInstall = `file:${path.resolve(
        originalDirectory,
        template.match(/^file:(.*)?$/)[1]
      )}`;
    } else if (
      template.includes('://') ||
      template.match(/^.+\.(tgz|tar\.gz)$/)
    ) {
      // for tar.gz or alternative paths
      templateToInstall = template;
    } else {
      // Add prefix 'pipesort-admin-template-' to non-prefixed templates, leaving any
      // @scope/ intact.
      const packageMatch = template.match(/^(@[^/]+\/)?(.+)$/);
      const scope = packageMatch[1] || '';
      const templateName = packageMatch[2];

      const name = templateName.startsWith(templateToInstall)
        ? templateName
        : `${templateToInstall}-${templateName}`;
      templateToInstall = `${scope}${name}`;
    }
  }

  return Promise.resolve(templateToInstall);
}

function getTemporaryDirectory() {
  return new Promise((resolve, reject) => {
    // Unsafe cleanup lets us recursively delete the directory if it contains
    // contents; by default it only allows removal if it's empty
    tmp.dir({ unsafeCleanup: true }, (err, tmpdir, callback) => {
      if (err) {
        reject(err);
      } else {
        resolve({
          tmpdir: tmpdir,
          cleanup: () => {
            try {
              callback();
            } catch (ignored) {
              // Callback might throw and fail, since it's a temp directory the
              // OS will clean it up eventually...
            }
          },
        });
      }
    });
  });
}

function extractStream(stream, dest) {
  return new Promise((resolve, reject) => {
    stream.pipe(
      unpack(dest, err => {
        if (err) {
          reject(err);
        } else {
          resolve(dest);
        }
      })
    );
  });
}

// Extract package name from tarball url or path.
function getPackageInfo(installPackage) {
  if (installPackage.match(/^.+\.(tgz|tar\.gz)$/)) {
    return getTemporaryDirectory()
      .then(obj => {
        let stream;
        if (/^http/.test(installPackage)) {
          stream = hyperquest(installPackage);
        } else {
          stream = fs.createReadStream(installPackage);
        }
        return extractStream(stream, obj.tmpdir).then(() => obj);
      })
      .then(obj => {
        const { name, version } = require(path.join(
          obj.tmpdir,
          'package.json'
        ));
        obj.cleanup();
        return { name, version };
      })
      .catch(err => {
        // The package name could be with or without semver version, e.g. react-scripts-0.2.0-alpha.1.tgz
        // However, this function returns package name only without semver version.
        console.log(
          `Could not extract the package name from the archive: ${err.message}`
        );
        const assumedProjectName = installPackage.match(
          /^.+\/(.+?)(?:-\d+.+)?\.(tgz|tar\.gz)$/
        )[1];
        console.log(
          `Based on the filename, assuming it is "${chalk.cyan(
            assumedProjectName
          )}"`
        );
        return Promise.resolve({ name: assumedProjectName });
      });
  } else if (installPackage.indexOf('git+') === 0) {
    // Pull package name out of git urls e.g:
    // git+https://github.com/mycompany/react-scripts.git
    // git+ssh://github.com/mycompany/react-scripts.git#v1.2.3
    return Promise.resolve({
      name: installPackage.match(/([^/]+)\.git(#.*)?$/)[1],
    });
  } else if (installPackage.match(/.+@/)) {
    // Do not match @scope/ when stripping off @version or @tag
    return Promise.resolve({
      name: installPackage.charAt(0) + installPackage.substr(1).split('@')[0],
      version: installPackage.split('@')[1],
    });
  } else if (installPackage.match(/^file:/)) {
    const installPackagePath = installPackage.match(/^file:(.*)?$/)[1];
    const { name, version } = require(path.join(
      installPackagePath,
      'package.json'
    ));
    return Promise.resolve({ name, version });
  }
  return Promise.resolve({ name: installPackage });
}

function checkNpmVersion() {
  let hasMinNpm = false;
  let npmVersion = null;
  try {
    npmVersion = execSync('npm --version')
      .toString()
      .trim();
    hasMinNpm = semver.gte(npmVersion, '5.0.0');
  } catch (err) {
    // ignore
  }
  return {
    hasMinNpm: hasMinNpm,
    npmVersion: npmVersion,
  };
}

function checkYarnVersion() {
  let hasMinYarnPnp = false;
  let yarnVersion = null;
  try {
    yarnVersion = execSync('yarnpkg --version')
      .toString()
      .trim();
    let trimmedYarnVersion = /^(.+?)[-+].+$/.exec(yarnVersion);
    if (trimmedYarnVersion) {
      trimmedYarnVersion = trimmedYarnVersion.pop();
    }
    hasMinYarnPnp = semver.gte(trimmedYarnVersion || yarnVersion, '1.12.0');
  } catch (err) {
    // ignore
  }
  return {
    hasMinYarnPnp: hasMinYarnPnp,
    yarnVersion: yarnVersion,
  };
}

function checkAppName(appName) {
  const validationResult = validateProjectName(appName);
  if (!validationResult.validForNewPackages) {
    console.error(
      `Could not create a project called ${chalk.red(
        `"${appName}"`
      )} because of npm naming restrictions:`
    );
    printValidationResults(validationResult.errors);
    printValidationResults(validationResult.warnings);
    process.exit(1);
  }

  // TODO: there should be a single place that holds the dependencies
  const dependencies = [].sort();
  if (dependencies.indexOf(appName) >= 0) {
    console.error(
      chalk.red(
        `We cannot create a project called ${chalk.green(
          appName
        )} because a dependency with the same name exists.\n` +
          `Due to the way npm works, the following names are not allowed:\n\n`
      ) +
        chalk.cyan(dependencies.map(depName => `  ${depName}`).join('\n')) +
        chalk.red('\n\nPlease choose a different project name.')
    );
    process.exit(1);
  }
}

// If project only contains files generated by GH, it’s safe.
// Also, if project contains remnant error logs from a previous
// installation, lets remove them now.
// We also special case IJ-based products .idea because it integrates with CRA:
// https://github.com/facebook/create-react-app/pull/368#issuecomment-243446094
function isSafeToCreateProjectIn(root, name) {
  const validFiles = [
    '.DS_Store',
    'Thumbs.db',
    '.git',
    '.gitignore',
    '.idea',
    'README.md',
    'LICENSE',
    '.hg',
    '.hgignore',
    '.hgcheck',
    '.npmignore',
    'mkdocs.yml',
    'docs',
    '.travis.yml',
    '.gitlab-ci.yml',
    '.gitattributes',
  ];
  console.log();

  const conflicts = fs
    .readdirSync(root)
    .filter(file => !validFiles.includes(file))
    // IntelliJ IDEA creates module files before CRA is launched
    .filter(file => !/\.iml$/.test(file))
    // Don't treat log files from previous installation as conflicts
    .filter(
      file => !errorLogFilePatterns.some(pattern => file.indexOf(pattern) === 0)
    );

  if (conflicts.length > 0) {
    console.log(
      `The directory ${chalk.green(name)} contains files that could conflict:`
    );
    console.log();
    for (const file of conflicts) {
      console.log(`  ${file}`);
    }
    console.log();
    console.log(
      'Either try using a new directory name, or remove the files listed above.'
    );

    return false;
  }

  // Remove any remnant files from a previous installation
  const currentFiles = fs.readdirSync(path.join(root));
  currentFiles.forEach(file => {
    errorLogFilePatterns.forEach(errorLogFilePattern => {
      // This will catch `(npm-debug|yarn-error|yarn-debug).log*` files
      if (file.indexOf(errorLogFilePattern) === 0) {
        fs.removeSync(path.join(root, file));
      }
    });
  });
  return true;
}

function getProxy() {
  if (process.env.https_proxy) {
    return process.env.https_proxy;
  } else {
    try {
      // Trying to read https-proxy from .npmrc
      let httpsProxy = execSync('npm config get https-proxy')
        .toString()
        .trim();
      return httpsProxy !== 'null' ? httpsProxy : undefined;
    } catch (e) {
      return;
    }
  }
}
function checkThatNpmCanReadCwd() {
  const cwd = process.cwd();
  let childOutput = null;
  try {
    // Note: intentionally using spawn over exec since
    // the problem doesn't reproduce otherwise.
    // `npm config list` is the only reliable way I could find
    // to reproduce the wrong path. Just printing process.cwd()
    // in a Node process was not enough.
    childOutput = spawn.sync('npm', ['config', 'list']).output.join('');
  } catch (err) {
    // Something went wrong spawning node.
    // Not great, but it means we can't do this check.
    // We might fail later on, but let's continue.
    return true;
  }
  if (typeof childOutput !== 'string') {
    return true;
  }
  const lines = childOutput.split('\n');
  // `npm config list` output includes the following line:
  // "; cwd = C:\path\to\current\dir" (unquoted)
  // I couldn't find an easier way to get it.
  const prefix = '; cwd = ';
  const line = lines.find(line => line.indexOf(prefix) === 0);
  if (typeof line !== 'string') {
    // Fail gracefully. They could remove it.
    return true;
  }
  const npmCWD = line.substring(prefix.length);
  if (npmCWD === cwd) {
    return true;
  }
  console.error(
    chalk.red(
      `Could not start an npm process in the right directory.\n\n` +
        `The current directory is: ${chalk.bold(cwd)}\n` +
        `However, a newly started npm process runs in: ${chalk.bold(
          npmCWD
        )}\n\n` +
        `This is probably caused by a misconfigured system terminal shell.`
    )
  );
  if (process.platform === 'win32') {
    console.error(
      chalk.red(`On Windows, this can usually be fixed by running:\n\n`) +
        `  ${chalk.cyan(
          'reg'
        )} delete "HKCU\\Software\\Microsoft\\Command Processor" /v AutoRun /f\n` +
        `  ${chalk.cyan(
          'reg'
        )} delete "HKLM\\Software\\Microsoft\\Command Processor" /v AutoRun /f\n\n` +
        chalk.red(`Try to run the above two lines in the terminal.\n`) +
        chalk.red(
          `To learn more about this problem, read: https://blogs.msdn.microsoft.com/oldnewthing/20071121-00/?p=24433/`
        )
    );
  }
  return false;
}

function checkIfOnline(useYarn) {
  if (!useYarn) {
    // Don't ping the Yarn registry.
    // We'll just assume the best case.
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    dns.lookup('registry.yarnpkg.com', err => {
      let proxy;
      if (err != null && (proxy = getProxy())) {
        // If a proxy is defined, we likely can't resolve external hostnames.
        // Try to resolve the proxy name as an indication of a connection.
        dns.lookup(url.parse(proxy).hostname, proxyErr => {
          resolve(proxyErr == null);
        });
      } else {
        resolve(err == null);
      }
    });
  });
}

function executeNodeScript({ cwd, args }, data, source) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...args, '-e', source, '--', JSON.stringify(data)],
      { cwd, stdio: 'inherit' }
    );

    child.on('close', code => {
      if (code !== 0) {
        reject({
          command: `node ${args.join(' ')}`,
        });
        return;
      }
      resolve();
    });
  });
}
