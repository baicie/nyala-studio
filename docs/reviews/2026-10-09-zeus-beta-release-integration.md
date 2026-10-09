# Zeus beta release integration status

Date: 2026-10-09

## Result

Nyala's revision-bound Zeus audit and platform workflow now pin
`@zeus-web/data-grid@0.1.0-beta.5`. The package is available from npm and its
tarball integrity, license, unpacked size, dependency closure, and generated
bundle all pass the local audit.

The beta.5 package still declares `@zeus-js/zeus@0.1.1-beta.2` as its peer and
declares the Zeus runtime wrappers at `0.1.1-beta.2`. Publishing Zeus core
`0.1.1-beta.3` therefore does not mean that beta.5 consumes core beta.3. Nyala
keeps the actual published closure in its audit contract and does not claim
the newer core is integrated.

## Registry evidence

| Package                 | Version        | Integrity / size                                                                                                 |
| ----------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@zeus-web/data-grid`   | `0.1.0-beta.5` | `sha512-dhfYvfFSzbukfrqQBR/RCUyhsEzpz7lL6U/np9U6OKaUIgMfSe6mSBD8SN66qciJEiLE99hK6U+7PvoG3jFgjw==`, 344,316 bytes |
| `@zeus-web/virtual`     | `0.1.0-beta.5` | `sha512-MRUYjs/94TXZj+36wH5DdCPCUSQjbwDeCqCfrVV/I0PsWKSuwVHbpfqTlFm9a43y4wmHq0oQl+p0WpG+BshVKg==`, 68,788 bytes  |
| `@zeus-web/zeus-compat` | `0.1.0-beta.5` | `sha512-6pcCqK/pCPui/o3J7E1UK6rP08yclBQt5JpnbW0L4bt/zrsuiiJKcpPMzlxZ0B28qztDfQX8jJGBS1l33c1Uaw==`, 5,929 bytes   |

The beta.5 data-grid tarball contains the split timing and `measureNodeChurn`
diagnostic API. The locally generated browser bundle is 90,773 bytes raw and
29,978 bytes gzip, leaving 22 bytes below the 30,000-byte budget.

## Gate status

The following suites pass after the pin update:

- `pnpm run test:sql-result-grid-zeus-audit` (3/3)
- `pnpm run test:sql-result-grid-gate` (19/19)
- `pnpm run test:sql-mvp-vnext-release` (35/35)

No new macOS WKWebView or Windows WebView2 benchmark has been collected from
this revision. Z1.3 remains `NO-GO`; A4 Checkpoint W still lacks the four real
manual accessibility/keyboard walkthroughs, and Z2/R0 must remain blocked.

## Follow-up

1. Ask zeus-ui to publish a follow-up package whose data-grid, virtual, and
   compat packages declare the core beta.3 closure, then update this contract
   only after registry metadata and tarballs are independently verified.
2. Merge the Nyala pin update through the protected branch, dispatch the
   platform workflow with `repeat=5`, and retain the resulting revision-bound
   artifacts before evaluating Z1.
3. Revisit the 30 KB bundle budget: beta.5 passes by 22 bytes, so any further
   generated bundle change should be treated as a likely budget regression.
