const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {promisify} = require('util');

const $mv = require('mv');
const xget = require('libxget');
const axios = require('axios');
const unzipper = require('unzipper');
const xprogress = require('xprogress');

const mv = promisify($mv);
const mkdir = promisify(fs.mkdir);
const rmdir = promisify(fs.rmdir);
const exists = promisify(fs.exists);

function genProgressBar(fileName, urlMeta, indent) {
  return xprogress.stream(
    urlMeta.size,
    urlMeta.chunkStack.map(chunk => chunk.size),
    {
      bar: {separator: '|'},
      template: [
        ':{indent}[:{label} :{fileName}] :{flipper}',
        ':{indent} [:{bar:complete}] [:3{percentage}%] [:{speed}] (:{eta})',
        ':{indent} [:{bar}] [:{size}]',
      ],
      clean: true,
      flipper: [...Array(10)].map((...[, i]) => `:{color}${'\u2022'.repeat(i + 1)}:{color:close}`),
      label: 'Downloading',
      variables: {
        fileName,
        size: (stack, _size, total) => ((total = stack.total), `${stack.size()}${total !== Infinity ? `/:{size:total}` : ''}`),
        indent: ' '.repeat(indent),
      },
    },
  );
}

function dl(fileName, url, indent) {
  const feed = xget(url, {timeout: 5000})
    .with('progressBar', urlMeta => genProgressBar(fileName, urlMeta, indent))
    .use('progressBar', (dataSlice, store) => store.get('progressBar').next(dataSlice.size))
    .on('end', () => feed.store.get('progressBar').end(`:{indent}\x1b[36m[\u2713]\x1b[0m Successfully Downloaded ${fileName}\n`))
    .on('retry', data => {
      const msg = `:{indent} \x1b[33m(i)\x1b[0m [${data.meta ? 'meta' : data.index}]{${data.retryCount}/${data.maxRetries}} [${
        data.lastErr.code
      }] (${data.lastErr}), retrying...`;
      if (data.store.has('progressBar')) data.store.get('progressBar').print(msg);
      else console.log(msg);
    })
    .on('error', err => {
      const msg =
        'index' in err ? `:{indent}\x1b[31m[!]\x1b[0m An error occurred [${err && (err.message || err.stack)}]` : `${err}`;
      if (feed.store.has('progressBar')) feed.store.get('progressBar').print(msg);
      else console.log(msg);
    });
  return feed;
}

function promisifyStream(stream, fn) {
  return new Promise((res, rej) => fn(stream, res, rej));
}

async function $do(entryMsg, indent, fn) {
  if (typeof indent === 'function') [fn, indent] = [indent, fn];
  indent = indent || 0;
  process.stdout.write(`${' '.repeat(indent)}\x1b[36m[•]\x1b[0m ${entryMsg}...`);
  const result = await fn();
  console.log('[\x1b[32mdone\x1b[0m]');
  return result;
}

async function main() {
  const BASEDIR = (_path => {
    while (!_path || fs.existsSync(_path)) _path = path.join(os.tmpdir(), `freyrsetup-${crypto.randomBytes(4).toString('hex')}`);
    return _path;
  })();

  const STAGEDIR = path.join(__dirname, 'interoper_pkgs');

  await $do('Creating environment', () => mkdir(BASEDIR));
  console.log(' (workspace) =', BASEDIR);

  if (await exists(STAGEDIR)) await $do('Resetting package stage', () => rmdir(STAGEDIR, {recursive: true}));
  await $do('Creating package stage', () => mkdir(STAGEDIR));
  console.log(' (  stage  ) =', STAGEDIR);

  // youtube-dl

  const ytdlFile = path.join(BASEDIR, 'raw@youtube-dl');

  await promisifyStream(
    dl('youtube-dl', 'https://yt-dl.org/downloads/latest/youtube-dl').pipe(fs.createWriteStream(ytdlFile)),
    (stream, res, rej) => stream.on('error', rej).on('close', res),
  );

  const ytdlExtractedPath = path.join(BASEDIR, 'source@youtube-dl');

  await $do('Parsing and processing youtube-dl', () =>
    fs
      .createReadStream(ytdlFile, {start: 22})
      .pipe(unzipper.Extract({path: ytdlExtractedPath}))
      .promise(),
  );

  await $do('Staging artifacts for youtube-dl', () =>
    mv(path.join(ytdlExtractedPath, 'youtube_dl'), path.join(STAGEDIR, 'youtube_dl')),
  );

  // ytmusicapi

  const {
    data: {zipball_url: ytmusicapiUrl},
  } = await $do('Querying latest version of ytmusicapi', () =>
    axios.get('https://api.github.com/repos/sigma67/ytmusicapi/releases/latest'),
  );

  const ytmusicapiFile = path.join(BASEDIR, 'raw@ytmusicapi');

  await promisifyStream(dl('ytmusicapi', ytmusicapiUrl).pipe(fs.createWriteStream(ytmusicapiFile)), (stream, res, rej) =>
    stream.on('error', rej).on('finish', res),
  );

  await $do('Parsing and staging ytmusicapi', async () => {
    const zip = fs.createReadStream(ytmusicapiFile).pipe(unzipper.Parse({forceStream: true}));
    // eslint-disable-next-line no-restricted-syntax
    for await (const entry of zip) {
      const {path: file, type} = entry;
      if (type !== 'Directory') {
        const pathStruct = file.split(path.sep).slice(1);
        if (pathStruct[0] === 'ytmusicapi') {
          const outPath = path.join(STAGEDIR, ...pathStruct);
          await mkdir(path.dirname(outPath), {recursive: true});
          await promisifyStream(entry.pipe(fs.createWriteStream(outPath)), (stream, res, rej) =>
            stream.on('error', rej).on('finish', res),
          );
          // eslint-disable-next-line no-continue
          continue;
        }
      }
      entry.autodrain();
    }
  });

  await $do('Cleaning up', () => rmdir(BASEDIR, {recursive: true}));
}

main().catch(err => console.log('An error occurred\n', err));