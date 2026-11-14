// Puts what a CI job printed where it can be read afterwards: into the run's summary and,
// with --notice, as a notice on the run (the part of a run anyone can read without signing in).
//
//   node scripts/ci-report.mjs [--from=<start of a line>] [--tail=<lines>] [--outcome=<step outcome>] [--notice] <title> <file>
//
// --from keeps the file from the first line that starts that way; --tail keeps its last lines,
// shown as plain text rather than as tables. A missing file is nothing to report, not an error:
// the step that was to write it may not have run.
import fs from 'node:fs';

const args = process.argv.slice(2);
const options = {};
while (args.length && args[0].startsWith('--')) {
  const [key, ...value] = args.shift().slice(2).split('=');
  options[key] = value.length ? value.join('=') : true;
}
const [title, file] = args;
if (!title || !file) {
  console.error('usage: ci-report.mjs [--from=<start of a line>] [--tail=<lines>] [--outcome=<step outcome>] [--notice] <title> <file>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.log(`${title}: nothing to report (no ${file})`);
  process.exit(0);
}

// without the colour codes a terminal would have been sent
let lines = fs.readFileSync(file, 'utf8').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/);
if (options.from) {
  const at = lines.findIndex((line) => line.startsWith(options.from));
  lines = at < 0 ? [] : lines.slice(at);
}
while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
const plain = !!options.tail;
if (plain) lines = lines.slice(-Number(options.tail));
let text = lines.join('\n');
const stopped = options.outcome && options.outcome !== 'success' && options.outcome !== true
  ? `The step ended as "${options.outcome}": this is as far as it got.`
  : '';
if (!text && !stopped) {
  console.log(`${title}: nothing to report (${file} has nothing to show)`);
  process.exit(0);
}

const summary = `## ${title}\n\n${plain ? '```\n' + text + '\n```' : text}\n${stopped ? '\n' + stopped + '\n' : ''}\n`;
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
else process.stdout.write(summary);

if (options.notice) {
  // a notice is one line: GitHub's own escapes for the rest
  const data = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const property = (s) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  const LIMIT = 48_000;
  if (stopped) text += '\n\n' + stopped;
  if (text.length > LIMIT) text = text.slice(0, LIMIT) + '\n(cut here: the whole of it is in the summary)';
  console.log(`::notice title=${property(title)}::${data(text)}`);
}
