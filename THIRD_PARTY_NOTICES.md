# Third-Party Notices

`dsh-pi-memory` is a port of **[pi-memory](https://github.com/jayzeng/pi-memory)** —
a Pi coding agent extension — into a DeepSeek Harness (`dsh`) plugin. The port
follows the [porting playbook](https://github.com/GongYuanCaiJi/deepseek-harness/blob/main/docs/port-playbook.md):
upstream code is copied 100% verbatim wherever it can run unchanged, and every
adaptation is listed in the delivery report of the porting ticket.

## Upstream package (pinned)

| Field | Value |
|-------|-------|
| name | `pi-memory` |
| pinned version | `0.4.2` |
| last modified | `2026-08-11` |
| npm tarball | `https://registry.npmjs.org/pi-memory/-/pi-memory-0.4.2.tgz` |
| integrity (npm `dist.integrity`) | `sha512-voH+1MalADyVN23p79g4atdtPxzr1bDcfk1y0uCJL0xfodiSzNA5V5CcmODBTtHlrQzDT+AgasYPlgNWg8YPRQ==` |
| shasum (npm `dist.shasum`) | `e77a0dc4bc53ac8b45683ce8cfc38701e21179e5` |
| gitHead | `39e6b998a2279c8fad4a2c6c64e26828c1d6023e` |
| upstream repo | <https://github.com/jayzeng/pi-memory> |
| upstream license | MIT (see [LICENSE](./LICENSE)) |

## Files carried over verbatim

"Verbatim" means byte-for-byte identical to the pinned upstream tarball
(`pi-memory-0.4.2.tgz`). Verify with the `cmp` commands below.

| File | SHA-256 | Upstream path |
|------|---------|---------------|
| `CHANGELOG.md` | `84f5d0e62063e48b6b2d24c51fe1b465badd96ee2999ed2928ea36b2efd86c24` | `package/CHANGELOG.md` |
| `scripts/postinstall.cjs` | `5ab264bc77c305b8d66d6c41fd451ede1f69ffc3ebcaf3241083a44343f7e71d` | `package/scripts/postinstall.cjs` |

```bash
# Verify verbatim files against the pinned upstream tarball:
cd "$(mktemp -d)" && curl -sL -o pi-memory.tgz \
  https://registry.npmjs.org/pi-memory/-/pi-memory-0.4.2.tgz && tar xzf pi-memory.tgz
cmp package/CHANGELOG.md              <(curl -sL https://raw.githubusercontent.com/jayzeng/pi-memory/39e6b998a2279c8fad4a2c6c64e26828c1d6023e/CHANGELOG.md) \
  && echo "CHANGELOG.md matches upstream" || echo "CHANGELOG.md differs"
cmp package/scripts/postinstall.cjs    <(curl -sL https://raw.githubusercontent.com/jayzeng/pi-memory/39e6b998a2279c8fad4a2c6c64e26828c1d6023e/scripts/postinstall.cjs) \
  && echo "scripts/postinstall.cjs matches upstream" || echo "scripts/postinstall.cjs differs"
```

## Adapted files

The remaining ported files (`index.js`, `test/*`, `.github/workflows/*`,
`package.json`) are adapted from upstream: the code is upstream logic, but the
entry shape, tool registration, and lifecycle wiring were changed to the dsh
plugin contract (`name`/`inject`/`Config`/`apply`). Every adaptation carries a
reason in the porting ticket's delivery report.

## License

`pi-memory` is MIT-licensed. The full license text, with both the upstream
copyright and the port's copyright, is in [LICENSE](./LICENSE).
