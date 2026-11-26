// test-pages-workflow.js — v1.0.266
//
// pages.yml used to upload the Pages artifact and deploy it in ONE job, back to back.
// deploy-pages asks the API for the artifact's metadata, and that read is not
// immediately consistent with the upload that just finished. On 25 Nov 2026 three runs
// in a row failed with "No artifacts named github-pages were found" — 277 ms after the
// upload step logged "successfully finalized. Artifact ID 14996319600". The artifact
// existed; a later query returned it, unexpired. The action has no retry for an empty
// result, so it gave up and the web app sat two releases behind.
//
// Splitting into build + deploy is GitHub's own documented shape, and the job boundary
// takes seconds rather than milliseconds — the race is removed rather than out-waited.
// A sleep tuned on one day's timing is a guess that fails on a slower day, so this
// suite also refuses one.
//
// Parsed as text, not with a YAML library: js-yaml is not a dependency of this repo.
//
// Run: node test-pages-workflow.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const wf = read('.github/workflows/pages.yml');

// Job bodies. Scanning the whole file for a two-space-indented name also matches
// `push:` under `on:`, so start at the jobs: block.
const jobsAt = wf.search(/^jobs:$/m);
const jobStarts = [...wf.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)]
  .filter(m => m.index > jobsAt)
  .map(m => ({ name: m[1], at: m.index }));

// The explanation of WHY the jobs are split lives in comments, and the words it warns
// against ("sleep") appear there too. Split the two so each assertion reads the right
// half: `code` for what the workflow does, `prose` for what it documents.
const lines = wf.split(/\r?\n/);
const code = lines.filter(l => !/^\s*#/.test(l)).join('\n');
const prose = lines.filter(l => /^\s*#/.test(l))
  .map(l => l.replace(/^\s*#\s?/, '')).join(' ');
const jobBody = name => {
  const i = jobStarts.findIndex(j => j.name === name);
  if (i < 0) return '';
  return wf.slice(jobStarts[i].at, i + 1 < jobStarts.length ? jobStarts[i + 1].at : wf.length);
};

section('the upload and the deploy are in SEPARATE jobs');
{
  t('there are exactly two jobs', jobStarts.length === 2, jobStarts.map(j => j.name));
  t('they are build and deploy',
    jobStarts.map(j => j.name).join(',') === 'build,deploy', jobStarts.map(j => j.name));
  t('deploy waits for build', /^    needs: build$/m.test(jobBody('deploy')));

  const build = jobBody('build'), deploy = jobBody('deploy');
  // This pair is the whole point. Both in one job is the bug.
  t('build uploads the artifact', /actions\/upload-pages-artifact@v3/.test(build));
  t('build does NOT deploy', !/actions\/deploy-pages/.test(build));
  t('deploy deploys', /actions\/deploy-pages@v4/.test(deploy));
  t('deploy does NOT upload', !/upload-pages-artifact/.test(deploy));
}

section('the race is removed, not waited out');
{
  // A sleep would pass CI on a fast day and fail on a slow one — the same class of
  // mistake as the 30 s print TTL this project just removed.
  t('no sleep between upload and deploy', !/\bsleep\b/.test(code));
  t('…and the workflow says why one would be wrong', /tuned today|tuned on one day/.test(prose));
  t('no hand-rolled retry loop around the artifact', !/until |while \[|for i in/.test(code));
  t('deploy-pages is not pinned to a fork or a floating ref',
    /actions\/deploy-pages@v4$/m.test(wf.match(/uses: actions\/deploy-pages@\S+/)[0]));
}

section('permissions are scoped to the job that needs them');
{
  const build = jobBody('build'), deploy = jobBody('deploy');
  // Splitting is the moment to stop handing the build job a Pages write token.
  t('the workflow grants nothing at the top level', /^permissions: \{\}$/m.test(wf));
  t('build may only read the repo',
    /permissions:\s*\n\s*contents: read/.test(build) && !/pages: write/.test(build));
  t('deploy gets the Pages write', /pages: write/.test(deploy));
  t('…and the OIDC token deploy-pages needs', /id-token: write/.test(deploy));
  // checkout fails without contents: read, and top-level {} grants nothing.
  t('build still has what checkout needs',
    /actions\/checkout@v4/.test(build) && /contents: read/.test(build));
}

section('the environment moved with the deploy, or the URL output breaks');
{
  const deploy = jobBody('deploy');
  t('the github-pages environment is on deploy', /environment:\s*\n\s*name: github-pages/.test(deploy));
  t('the page url reads from a step in the SAME job',
    /url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/.test(deploy));
  t('…and that step id exists here', /id: deployment/.test(deploy));
  t('the environment is not left behind on build', !/environment:/.test(jobBody('build')));
}

section('nothing else about the deploy changed');
{
  const build = jobBody('build');
  // Regression guards: these are what actually make the web deploy work.
  t('the Firebase password is still injected', /FIREBASE_TEAM_PASSWORD/.test(build));
  t('the Drive client id is still injected', /GOOGLE_CLIENT_ID/.test(build));
  t('the service-worker cache version is still stamped',
    /const CACHE_VERSION/.test(build) && /BUILD_TS/.test(build));
  t('the whole site is still what gets uploaded', /path: '\.'/.test(build));
  t('it still runs on push to main and on demand',
    /branches: \[main\]/.test(wf) && /workflow_dispatch/.test(wf));
  t('one deploy at a time', /group: "pages"/.test(wf) && /cancel-in-progress: false/.test(wf));
}

section('the reason is written down where someone would undo it');
{
  // A future edit that recombines the jobs for tidiness would reintroduce a failure
  // whose cause is invisible in the logs — the upload step reports success.
  t('the incident is explained in the workflow', /not\s+immediately consistent/.test(prose));
  t('…with the symptom someone would search for',
    /No artifacts named github-pages were found/.test(prose));
  t('…and the warning that a re-run makes it worse',
    /count is 2/.test(prose) && /fresh run/.test(prose));
}

section('the desktop release workflow is untouched');
{
  // Different problem, different shape: it is one job on purpose, because latest.json
  // is generated from the signature files left in the build tree.
  const desk = read('.github/workflows/release-desktop.yml');
  t('still triggered by a v tag', /- 'v\*'/.test(desk));
  t('still the only workflow that writes latest.json',
    /latest\.json/.test(desk) && !/latest\.json/.test(wf));
  t('the sandbox workflow still writes none',
    !/latest\.json/.test(read('.github/workflows/release-test.yml').replace(/^\s*#.*$/gm, '')));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
