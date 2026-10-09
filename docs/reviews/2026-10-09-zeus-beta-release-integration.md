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

Before the post-merge run below, no new macOS WKWebView or Windows WebView2
benchmark had been collected from this revision. Z1.3 remains `NO-GO`; A4
Checkpoint W still lacks the four real manual accessibility/keyboard
walkthroughs, and Z2/R0 must remain blocked.

### Platform run `37937953442`

The first post-merge run was dispatched from `mvp` at revision
`bf0040a4c2f694cb093d22c31588eb82b382db4a` with `repeat=5`. Both native jobs
completed successfully and all four artifacts were uploaded without expiry:

- Windows WebView2 artifact digest: `sha256:d24037273f5d51a9dad155d204de1e13aad3245192309830ae1978ba1e24e07f`
- macOS WKWebView artifact digest: `sha256:9f4f0f73f3346bfea952ee32b47f5a2f02b226e7259c2242f3c13fdcd21dc11e`
- aggregate gate artifact digest: `sha256:da21530f64b0cbfec456cb65ea5696dc070ed82ba6a422cadf2edf861fe2fb0e`
- Zeus audit artifact digest: `sha256:1f52db605ee49ebf7645647e17e3a91e9e582080f35cd1679e4d591a28aee384`

The aggregate gate was `NO-GO` for two measured reasons: the Chromium 10k x 50
Zeus p95 was 26.3 ms versus a 20.7 ms WorkbenchTable baseline (`-27.1%`), and
macOS 1k x 20 was 38 ms versus a 32 ms baseline (`18.8%` regression, above the
10% limit). Chromium 1k x 20 passed at `5.2%` regression. The run therefore
refreshes the evidence but does not change the Z1 decision.

## Follow-up

1. Ask zeus-ui to publish a follow-up package whose data-grid, virtual, and
   compat packages declare the core beta.3 closure, then update this contract
   only after registry metadata and tarballs are independently verified.
2. Merge the Nyala pin update through the protected branch, dispatch the
   platform workflow with `repeat=5`, and retain the resulting revision-bound
   artifacts before evaluating Z1.
3. Revisit the 30 KB bundle budget: beta.5 passes by 22 bytes, so any further
   generated bundle change should be treated as a likely budget regression.
