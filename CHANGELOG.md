# Changelog

## [0.2.9](https://github.com/OpenPowerShift/logic-diagram-language/compare/v0.2.8...v0.2.9) (2026-07-25)


### Features

* **layout:** Brandes–Köpf block straightening core ([#15](https://github.com/OpenPowerShift/logic-diagram-language/issues/15)) ([1ed2a24](https://github.com/OpenPowerShift/logic-diagram-language/commit/1ed2a24c188903997e0c0c25911e89a8e28bf77f))
* **layout:** Brandes–Köpf block straightening core ([#15](https://github.com/OpenPowerShift/logic-diagram-language/issues/15)) ([93cd78a](https://github.com/OpenPowerShift/logic-diagram-language/commit/93cd78aa1e81f9a6f690be2dab1a0d9a576dd011))
* **layout:** crossing-aware OUTPUT_ORDER = AUTO tie-break ([#36](https://github.com/OpenPowerShift/logic-diagram-language/issues/36)) ([#41](https://github.com/OpenPowerShift/logic-diagram-language/issues/41)) ([8680420](https://github.com/OpenPowerShift/logic-diagram-language/commit/8680420ad8b429eb55631b420805d8a6b47cde4e))
* **layout:** FANOUT_CONNECTORS as a scored candidate axis + glyph ([#37](https://github.com/OpenPowerShift/logic-diagram-language/issues/37)) ([7cf2d42](https://github.com/OpenPowerShift/logic-diagram-language/commit/7cf2d4236e5ab28f87fd0e051b92623d0a9a230e))
* **layout:** off-page connector fan-out for high-degree nets (fixes [#37](https://github.com/OpenPowerShift/logic-diagram-language/issues/37)) ([a71cf68](https://github.com/OpenPowerShift/logic-diagram-language/commit/a71cf68a8a8fc56c662444a88518cbf533471e61))
* **layout:** off-page connector fan-out prototype ([#37](https://github.com/OpenPowerShift/logic-diagram-language/issues/37)) ([bf9ae99](https://github.com/OpenPowerShift/logic-diagram-language/commit/bf9ae99e321d8a0b04bad34d0543145bb2478b10))
* **render:** implement LABEL_STYLE = SIDE ([#21](https://github.com/OpenPowerShift/logic-diagram-language/issues/21), part 2) ([89979b3](https://github.com/OpenPowerShift/logic-diagram-language/commit/89979b3297b30f76ee8c4664b66bd0b6e5f1e59b))
* **render:** implement LABEL_STYLE = SIDE ([#21](https://github.com/OpenPowerShift/logic-diagram-language/issues/21), part 2) ([42f4651](https://github.com/OpenPowerShift/logic-diagram-language/commit/42f465178d38af8d26954971bd13575a6719a787))
* **render:** PORT_STYLE = NONE — streamlined view without terminal dots ([a441c10](https://github.com/OpenPowerShift/logic-diagram-language/commit/a441c10b4816fe75fe779145915196941cfad4ab)), closes [#18](https://github.com/OpenPowerShift/logic-diagram-language/issues/18)
* **render:** PORT_STYLE = NONE — streamlined view without terminal dots (closes [#18](https://github.com/OpenPowerShift/logic-diagram-language/issues/18)) ([eb6b5bd](https://github.com/OpenPowerShift/logic-diagram-language/commit/eb6b5bd34afc28d056cd301b699a29e717743fb2))


### Bug Fixes

* **27:** generalise trunk merge + AUTO shallower-source tie-break ([34d5df5](https://github.com/OpenPowerShift/logic-diagram-language/commit/34d5df53eb42f5aace45a8d1748fc55c311a2e95))
* **graph:** render .Name/.Description once on a name↔id collision ([#16](https://github.com/OpenPowerShift/logic-diagram-language/issues/16)) ([a9f38cc](https://github.com/OpenPowerShift/logic-diagram-language/commit/a9f38ccd08cafe96252d817744d42539948dc235))
* **graph:** render .Name/.Description once on a name↔id collision (fixes [#16](https://github.com/OpenPowerShift/logic-diagram-language/issues/16)) ([7d0cc23](https://github.com/OpenPowerShift/logic-diagram-language/commit/7d0cc23399e5745c8d01218c7439c9b20987e2b6))
* **layout:** collapse whitespace between weakly-connected sections ([#17](https://github.com/OpenPowerShift/logic-diagram-language/issues/17)) ([e89ed2d](https://github.com/OpenPowerShift/logic-diagram-language/commit/e89ed2daeafaa514cc8248b83d809a7880c286e2))
* **layout:** collapse whitespace between weakly-connected sections (fixes [#17](https://github.com/OpenPowerShift/logic-diagram-language/issues/17)) ([95edd49](https://github.com/OpenPowerShift/logic-diagram-language/commit/95edd49e113cdc285b294d22b7d09daf03be09e6))
* **layout:** make crossing-minimizer barycenter port-aware ([9b3da44](https://github.com/OpenPowerShift/logic-diagram-language/commit/9b3da445d5fa762522320fe5430312db534e3d2a)), closes [#14](https://github.com/OpenPowerShift/logic-diagram-language/issues/14)
* **layout:** net labels avoid boundary input/output labels ([#21](https://github.com/OpenPowerShift/logic-diagram-language/issues/21), part 1) ([8732eac](https://github.com/OpenPowerShift/logic-diagram-language/commit/8732eac1e7cb84f00f487a1b03add516f98dda50))
* **layout:** net labels avoid boundary input/output labels ([#21](https://github.com/OpenPowerShift/logic-diagram-language/issues/21), part 1) ([eb636a5](https://github.com/OpenPowerShift/logic-diagram-language/commit/eb636a5b57934214e77a0b88d324349390a5326f))
* **layout:** port-aware crossing-minimizer barycenter (fixes [#14](https://github.com/OpenPowerShift/logic-diagram-language/issues/14)) ([6552bc2](https://github.com/OpenPowerShift/logic-diagram-language/commit/6552bc2ec5c56053861207cbaed14189fc276a72))
* **layout:** shallower-source wins AUTO tie-break (Shared Intermediates [#27](https://github.com/OpenPowerShift/logic-diagram-language/issues/27) c) ([5b7bdfa](https://github.com/OpenPowerShift/logic-diagram-language/commit/5b7bdfad6aea2acfc73c9bb859680f353108bd10))
* **layout:** trunk merge multi-bend peels (Shared Intermediates [#27](https://github.com/OpenPowerShift/logic-diagram-language/issues/27) a) ([529fa83](https://github.com/OpenPowerShift/logic-diagram-language/commit/529fa8364c70a0c0535a918624d960ab568a443b))
* **render:** typeset TeX math in block/gate/net labels + valid SVG for "&lt;" ([88ed5bb](https://github.com/OpenPowerShift/logic-diagram-language/commit/88ed5bbdd89d782b6e73def41367ea0cc8645372)), closes [#13](https://github.com/OpenPowerShift/logic-diagram-language/issues/13)
* **render:** typeset TeX math in block/gate/net labels + valid SVG for "&lt;" (fixes [#13](https://github.com/OpenPowerShift/logic-diagram-language/issues/13)) ([bd6044a](https://github.com/OpenPowerShift/logic-diagram-language/commit/bd6044a15c52f3c8364fd01100473198a8cd6e0f))


### Performance Improvements

* **crossmin:** incremental transpose swap delta (fixes [#44](https://github.com/OpenPowerShift/logic-diagram-language/issues/44)) ([#45](https://github.com/OpenPowerShift/logic-diagram-language/issues/45)) ([785ce7d](https://github.com/OpenPowerShift/logic-diagram-language/commit/785ce7d0ca39c292a5bc528b6ad113f274f66ef0))
* **crossmin:** precompute port offsets + O(1) transpose reindex ([#23](https://github.com/OpenPowerShift/logic-diagram-language/issues/23), first increment) ([0be6d61](https://github.com/OpenPowerShift/logic-diagram-language/commit/0be6d6101e74e6dd6406a83d7667b1f28f00b619))
* **crossmin:** precompute port offsets + O(1) transpose reindex ([#23](https://github.com/OpenPowerShift/logic-diagram-language/issues/23)) ([904456d](https://github.com/OpenPowerShift/logic-diagram-language/commit/904456d215411f0edf6dc322fe5b47755b1a0576))
* **routing:** filter PASS 4 input-unwrap to a local wire pool (fixes [#46](https://github.com/OpenPowerShift/logic-diagram-language/issues/46)) ([#47](https://github.com/OpenPowerShift/logic-diagram-language/issues/47)) ([9eb0227](https://github.com/OpenPowerShift/logic-diagram-language/commit/9eb02276613dedcacdd20a022ade565beafd5767))
* **symmetry:** count only mover-involving crossings (fixes [#42](https://github.com/OpenPowerShift/logic-diagram-language/issues/42)) ([#43](https://github.com/OpenPowerShift/logic-diagram-language/issues/43)) ([348bc93](https://github.com/OpenPowerShift/logic-diagram-language/commit/348bc93949188cfcbde6dd0aeb3dfaa2363d99f0))

## [0.2.8](https://github.com/OpenPowerShift/logic-diagram-language/compare/v0.2.7...v0.2.8) (2026-07-23)


### Bug Fixes

* correct repository URL casing for npm provenance ([a5da546](https://github.com/OpenPowerShift/logic-diagram-language/commit/a5da54667100858662803637e2afcdb9174f9f64))

## [0.2.7](https://github.com/OpenPowerShift/logic-diagram-language/compare/v0.2.6...v0.2.7) (2026-07-23)


### Bug Fixes

* run pre/postpublish scripts as ESM and read README.adoc ([791b477](https://github.com/OpenPowerShift/logic-diagram-language/commit/791b4775be1b198911b32b27031bde1c45af43d4))

## [0.2.6](https://github.com/OpenPowerShift/logic-diagram-language/compare/v0.2.5...v0.2.6) (2026-07-23)


### Bug Fixes

* Change README to Asciidoc ([bd7c348](https://github.com/OpenPowerShift/logic-diagram-language/commit/bd7c3487c2fc09633b66af8026321c3a8dd7f6e7))

## [0.2.5](https://github.com/OpenPowerShift/logic-diagram-language/compare/v0.2.4...v0.2.5) (2026-07-23)


### Bug Fixes

* Update OIDC Trusted Publishing ([39338b2](https://github.com/OpenPowerShift/logic-diagram-language/commit/39338b20da3866d1ed1516abce2827cd10b3e130))

## [0.2.4](https://github.com/OpenPowerShift/logic-diagram-language/compare/v0.2.3...v0.2.4) (2026-07-19)


### Bug Fixes

* Debug release workflow ([0d075d3](https://github.com/OpenPowerShift/logic-diagram-language/commit/0d075d33035a3252b9956b7c2a8727d19291c426))

## [0.2.3](https://github.com/OpenPowerShift/logic-diagram-language/compare/v0.2.2...v0.2.3) (2026-07-19)


### Bug Fixes

* Debug release workflow ([e4b8ae8](https://github.com/OpenPowerShift/logic-diagram-language/commit/e4b8ae8821262af47d67f876b0d65239f9b1f0bc))

## [0.2.2](https://github.com/OpenPowerShift/logic-diagram-language/compare/v0.2.1...v0.2.2) (2026-07-19)


### Bug Fixes

* add release debugging ([da29149](https://github.com/OpenPowerShift/logic-diagram-language/commit/da29149a2b0020455757a03b47e2ba1ec759eae1))

## [0.2.1](https://github.com/OpenPowerShift/logic-diagram-language/compare/v0.2.0...v0.2.1) (2026-07-19)


### Bug Fixes

* enable OIDC publishing. ([1cd0942](https://github.com/OpenPowerShift/logic-diagram-language/commit/1cd0942ff9792330fb2a5a02f891ae1b17f0780d))

## [0.2.0](https://github.com/OpenPowerShift/logic-diagram-language/compare/v0.1.0...v0.2.0) (2026-07-19)


### ⚠ BREAKING CHANGES

* fold showLabels/showIds into RenderOptions — renderDiagram(diagram, options?, theme?)
* drop redundant portMeta param — renderDiagram(diagram, …) reads diagram.portMeta

### Bug Fixes

* net-label leaders orphaned and labels overlapping wires ([fd26cac](https://github.com/OpenPowerShift/logic-diagram-language/commit/fd26cac9b4df101956e90aa8cc407f647fb1069c))
* playground build broken by sideEffects; library builds to lib/ ([6caac84](https://github.com/OpenPowerShift/logic-diagram-language/commit/6caac849bd964e3cb0faae2e4233ce559f755a39))


### Code Refactoring

* drop redundant portMeta param — renderDiagram(diagram, …) reads diagram.portMeta ([6d1dc70](https://github.com/OpenPowerShift/logic-diagram-language/commit/6d1dc7008851c5d1b4bcf3d7ab485d7bebc5a3ed))
* fold showLabels/showIds into RenderOptions — renderDiagram(diagram, options?, theme?) ([5ab7a1c](https://github.com/OpenPowerShift/logic-diagram-language/commit/5ab7a1c87ca1d6bb5b29b41b81440c87cb1471ff))

## 0.1.0 (2026-07-19)


### Features

* publishable library, API docs, and release automation ([2bf14c2](https://github.com/OpenPowerShift/logic-diagram-language/commit/2bf14c2332b2626b145b2ac4a7fb727254aa8391))


### Bug Fixes

* intermediate labels drifted from their gates under COMPACTNESS ([fcb3ade](https://github.com/OpenPowerShift/logic-diagram-language/commit/fcb3adedb4ba0092c70ad15e8a19bfd11649fe88))
* no junction dot at a shared trunk corner (only at real branches) ([8bb3b78](https://github.com/OpenPowerShift/logic-diagram-language/commit/8bb3b78cf14b383b585eea717cbbd6b03ed06222))
