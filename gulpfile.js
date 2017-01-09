const fs = require('fs');
const logging = require('plylog');
const path = require('path');
const gulp = require('gulp');
const mergeStream = require('merge-stream');
const del = require('del');
const gulpif = require('gulp-if');
const uglify = require('gulp-uglify');
const cleanCSS = require('gulp-clean-css');
const postCSS = require('gulp-postcss');
const sourceMaps = require('gulp-sourcemaps');
const autoPrefixer = require('gulp-autoprefixer');
const htmlmin = require('gulp-html-minifier');
const polymer = require('polymer-build');
const polymerJsonPath = path.join(process.cwd(), 'polymer.json');
const polymerJSON = require(polymerJsonPath);
const polymerProject = new polymer.PolymerProject(polymerJSON);
const rootBuild = 'build';
const unbundledDirectory = 'build/unbundled';
const bundledDirectory = 'build/bundled';

let logger = logging.getLogger('cli.build.sw-precache');

function waitFor(stream) {
  return new Promise((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

function waitForAll(unbundledPostProcessing, bundledPostProcessing) {
  return new Promise((resolve, reject) => {
    var finished = 0;
    //on end add 1 to finished if more than 1 finish as success
    unbundledPostProcessing.then(_ => {
      finished++;
      if(finished > 1) {
        resolve();
      };
    });
    bundledPostProcessing.then(_ => {
      finished++;
      if(finished > 1) {
        resolve();
      };
    });

    //reject with errors
    unbundledPostProcessing.catch(err => {
      reject();
    });
    bundledPostProcessing.catch(err => {
      reject();
    })
  });
}

function parsePreCacheConfig(configFile) {
    return new Promise((resolve, _reject) => {
        fs.stat(configFile, (statError) => {
            let config;
            // only log if the config file exists at all
            if (!statError) {
                try {
                    config = require(configFile);
                }
                catch (loadError) {
                    logger.warn(`${configFile} file was found but could not be loaded`, { loadError });
                }
            }
            resolve(config);
        });
    });
}

function build() {
  return new Promise((resolve, reject) => {
    // Okay, so first thing we do is clear the build
    console.log(`Deleting build/ directory...`);
    del([rootBuild])
      .then(_ => {
        // Okay, now lets get your source files
        let sourcesStream = polymerProject.sources()
          // Oh, well do you want to minify stuff? Go for it!
          // Here's how splitHtml & gulpif work
          .pipe(polymerProject.splitHtml())
          .pipe(gulpif(/\.js$/, uglify()))
          .pipe(gulpif(/\.css$/, autoPrefixer()))
          .pipe(gulpif(/\.css$/, cleanCSS()))
          .pipe(gulpif(/\.html$/, htmlmin({collapseWhitespace: true})))
          .pipe(polymerProject.rejoinHtml());

        // Okay now lets do the same to your dependencies
        let depsStream = polymerProject.dependencies()
          .pipe(polymerProject.splitHtml())
          .pipe(gulpif(/\.js$/, uglify()))
          .pipe(gulpif(/\.css$/, autoPrefixer()))
          .pipe(gulpif(/\.css$/, cleanCSS()))
          .pipe(gulpif(/\.html$/, htmlmin({collapseWhitespace: true})))
          .pipe(polymerProject.rejoinHtml());

        // Okay, now lets merge them into a single build stream.
        let buildStream = mergeStream(sourcesStream, depsStream)
          .once('data', () => {
            console.log('Analyzing build dependencies...');
          });

        //fork to unbundled /build dir
        let unbundledBuildStream = polymer.forkStream(buildStream)
          .pipe(gulp.dest(unbundledDirectory));
        //fork to bundled /build dir
        let bundledBuildStream = polymer.forkStream(buildStream)
          .pipe(polymerProject.bundler)
          .pipe(gulp.dest(bundledDirectory));


        let swPrecacheConfig = path.resolve('sw-precache-config.js');
        let loadSWConfig = parsePreCacheConfig(swPrecacheConfig);
          loadSWConfig.then((swConfig) => {
            if (swConfig) {
                logger.debug(`Service worker config found`, swConfig);
            }
            else {
                logger.debug(`No service worker configuration found at ${swPrecacheConfig}, continuing with defaults`);
            }
        });
        // Once the unbundled build stream is complete, create a service worker for the build
        let unbundledPostProcessing = Promise.all([loadSWConfig, waitFor(unbundledBuildStream)]).then((results) => {
            let swConfig = results[0];
            return polymer.addServiceWorker({
                buildRoot: unbundledDirectory,
                project: polymerProject,
                swConfig: swConfig,
            });
        });
        // Once the bundled build stream is complete, create a service worker for the build
        let bundledPostProcessing = Promise.all([loadSWConfig, waitFor(bundledBuildStream)]).then((results) => {
            let swConfig = results[0];
            return polymer.addServiceWorker({
                buildRoot: bundledDirectory,
                project: polymerProject,
                swConfig: swConfig,
                bundled: true,
            });
        });
        // waitFor the buildStream to complete
        return waitForAll(unbundledPostProcessing, bundledPostProcessing);
      })
      .then(_ => {
        // You did it!
        console.log('Build complete!');
        resolve();
      });
  });
}

gulp.task('default', build);
