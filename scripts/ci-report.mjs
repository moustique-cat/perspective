// Puts what a CI job printed where it can be read afterwards: into the run's summary and,
// with --notice, as notices on the run (the part of a run anyone can read without signing in).
//
//   node scripts/ci-report.mjs [--from=<start of a line>] [--tail=<lines>] [--outcome=<step outcome>]
//                              [--notice [--notice-columns=<n>] [--notice-plain]] <title> <file>
//
// --from keeps the file from the first line that starts that way; --tail keeps its last lines,
// shown as plain text rather than as tables. A missing file is nothing to report, not an error:
// the step that was to write it may not have run.
//
// GitHub keeps the first 4,096 bytes of a notice and drops the rest without a word, so a notice
// carries less than the summary: with --notice-columns its tables keep their first columns (and
// a row's closing [note]), with --notice-plain it is the file's lines that are not tables, and
// what is still too long is spread over a few notices.
import fs from 'node:fs';

const args = process.argv.slice(2);
const options = {};
while (args.length && args[0].startsWith('--')) {
  const [key, ...value] = args.shift().slice(2).split('=');
  options[key] = value.length ? value.join('=') : true;
}
const [title, file] = args;
if (!title || !file) {
  console.error('usage: ci-report.mjs [--from=<start of a line>] [--tail=<lines>] [--outcome=<step outcome>] [--notice [--notice-columns=<n>] [--notice-plain]] <title> <file>');
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
const whole = lines;
const plain = !!options.tail;
if (plain) lines = lines.slice(-Number(options.tail));
const text = lines.join('\n');
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
  const ROOM = 3900, MOST = 5;
  const bytes = (t) => Buffer.byteLength(t, 'utf8');
  const isTable = (line) => /^\s*\|/.test(line);
  const columns = Number(options['notice-columns']) || 0;
  const narrow = (line) => {
    if (!columns || !isTable(line)) return line;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    if (cells.length <= columns) return '| ' + cells.join(' | ') + ' |';
    const note = /\[[^\]]*\]$/.exec(cells[cells.length - 1]);
    return '| ' + cells.slice(0, columns).join(' | ') + (note ? ' | ' + note[0] : '') + ' |';
  };
  let rows = options['notice-plain'] ? whole.filter((line) => line.trim() && !isTable(line)) : lines.map(narrow);
  if (stopped) rows = [...rows, '', stopped];
  // whole lines to a notice, as many as fit
  const parts = [[]];
  let size = 0;
  for (let line of rows) {
    while (bytes(line) > ROOM) line = line.slice(0, line.length - 100);
    if (size + bytes(line) + 1 > ROOM && parts[parts.length - 1].length) { parts.push([]); size = 0; }
    parts[parts.length - 1].push(line);
    size += bytes(line) + 1;
  }
  // of a plain report the end says most (who passed, who failed); of a table, the beginning
  const kept = options['notice-plain'] ? parts.slice(-MOST) : parts.slice(0, MOST);
  // a notice is one line: GitHub's own escapes for the rest
  const data = (t) => t.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const property = (t) => data(t).replace(/:/g, '%3A').replace(/,/g, '%2C');
  kept.forEach((part, i) => {
    const name = kept.length > 1 ? `${title} (${i + 1} of ${kept.length})` : title;
    console.log(`::notice title=${property(name)}::${data(part.join('\n'))}`);
  });
  if (kept.length < parts.length) console.log(`${title}: ${parts.length - kept.length} more notices' worth is in the summary only`);
}
