Status: DONE
Commits created: 5c6efc6 fix(scripts): build dist when missing and stop assuming main branch
One-line test summary: `bash -n scripts/install.sh` passed; `grep -n 'git pull origin main' scripts/install.sh` returned no matches; `grep -n 'dist/main.js' scripts/install.sh` showed the new existence check at line 257.
Concerns, if any: None.
Report file path: `/Users/cagyo/projects/matapi_ai/worker/.superpowers/sdd/task-3-report.md`
