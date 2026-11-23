# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Hawdiias/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Hawdiias/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in replacement for make.fun's makefun-site 1.0.0, the reference
static site generator of the "Build a static site faster" bounty. `run(input)`
in `solve.js` returns the same output tree makefun-site 1.0.0 returns for
every site — every page's index.html, the index and tag pages,
build-report.txt and each static file, byte for byte — in about a third of
its CPU time.

Where the speed comes from:

- Templates are compiled once per build into plain JavaScript functions;
  paths a for-loop binds become direct variable reads, and includes still
  render in the caller's scope.
- The Markdown inline pass jumps between construct characters with one
  regexp scan and copies plain runs untouched, instead of escaping
  character by character.
- Block classification tests first characters by hand instead of running
  half a dozen regular expressions over every line.
- Slugs are memoised inside a build (tag names and headings repeat
  constantly), link targets are memoised per source, and reading time is
  counted in one pass without allocating the word list.

Verified byte-identical to makefun-site 1.0.0 on the kit's practice set,
on 60 further sites drawn with the competition's own generator, and on a
118-case edge battery (front-matter refusals, slug collisions, template
errors, include depth, broken links, CRLF, unicode).

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=t1er4017&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
