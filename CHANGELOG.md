# Changelog

All notable changes are documented here. The format follows [Conventional Commits](https://www.conventionalcommits.org/) and the version scheme is [Semantic Versioning](https://semver.org/).

## 1.0.0 (2026-09-08)


### Features

* **adapters:** derive the target key from a page URL ([24d7763](https://github.com/khasky/emojery/commit/24d776381afb0a5889d260919c35c93efcabbd44))
* **adapters:** find the action row and place the trigger in it ([5c8b3cb](https://github.com/khasky/emojery/commit/5c8b3cb875476697b11116074718daebd60c295c))
* **adapters:** scan a page for targets and re-scan what it mutates ([cf254f9](https://github.com/khasky/emojery/commit/cf254f9a3f52e12ca8ca3f42fdaa238c95f57e91))
* **amazon:** add the adapter ([0be5406](https://github.com/khasky/emojery/commit/0be5406275aea2a570074ed1c5c2b4e1d76b7e06))
* **auth:** return to the page the sign-in started from ([6392301](https://github.com/khasky/emojery/commit/6392301a811ee5a3231bb5cc5e822b09375e7e8e))
* **auth:** sign in with a one-time code from the auth page ([fe551b1](https://github.com/khasky/emojery/commit/fe551b1ea04b5b2ab442fdbfea9748d798313e2f))
* **background:** hold the anonymous identity and the API session ([d8cdeab](https://github.com/khasky/emojery/commit/d8cdeab5193abe7654f170a533a7e3c085e08faa))
* **background:** reject a message that does not match the contract ([15a3094](https://github.com/khasky/emojery/commit/15a3094fbfbfe0d8af544bfadeb6f5b181f864f2))
* **background:** route every content-script message to its handler ([272447b](https://github.com/khasky/emojery/commit/272447b16170c100c4f1dfa78f0a663109e0431a))
* **badge:** pulse the onboarding dot once the icon is pinned ([f8b5135](https://github.com/khasky/emojery/commit/f8b513578771049d7437c5949de48fa8bea7b783))
* **badge:** show the pending votes on the toolbar icon ([ea4dad9](https://github.com/khasky/emojery/commit/ea4dad96f39e8d9a9fe31024290deafe561d7184))
* **extension:** declare the manifest and the build modes ([e838585](https://github.com/khasky/emojery/commit/e83858557a9c50ed39689796372a228b35f0e3c8))
* **facebook:** add the adapter ([0a25660](https://github.com/khasky/emojery/commit/0a2566063b2587ec96f2f655a557700dc23ab049))
* **github:** add the adapter ([b165762](https://github.com/khasky/emojery/commit/b165762a2ec072b7c0b92484735400ede671192e))
* **gitlab:** add the adapter ([0cf93fe](https://github.com/khasky/emojery/commit/0cf93fee67d35346852b589ade221950fa0c3e21))
* **history:** browse the reaction history from the popup ([a2b0161](https://github.com/khasky/emojery/commit/a2b0161403d3f449a7b667f575168953e628b5d0))
* **history:** keep the history and the vote queue in indexeddb ([a5cb425](https://github.com/khasky/emojery/commit/a5cb42560ab92e42813ceca7e6b25365ef14bc83))
* **i18n:** read interface strings through the browser API ([be911d1](https://github.com/khasky/emojery/commit/be911d1c665db51c01bfc228e622d29f835e3dfb))
* **i18n:** ship the interface strings in 26 locales ([5a4720a](https://github.com/khasky/emojery/commit/5a4720a7f2ecd83507a4d2c320810102ffbe9abf))
* **instagram:** add the adapter ([1eda3bf](https://github.com/khasky/emojery/commit/1eda3bfe6a639956052d225f0c2c70dfad2f0569))
* **mount:** blend the trigger into the row it lands in ([4755261](https://github.com/khasky/emojery/commit/47552618f77c16734dbc9b7c1a1f5b95bb4610d6))
* **mount:** mount the trigger into a shadow root on the page ([c8553ce](https://github.com/khasky/emojery/commit/c8553cef5d0686fae5318245bfd7eabf40ad194f))
* **onboarding:** note the roadmap sites after the supported-site chips ([c7e66aa](https://github.com/khasky/emojery/commit/c7e66aae83cc1a4276e062680f006d82e984d206))
* **onboarding:** walk a new install through the first reaction ([d9e9429](https://github.com/khasky/emojery/commit/d9e94290c5e9c794454b1633b3455ad1fb652bec))
* **picker:** render the reaction picker ([7f9aa8f](https://github.com/khasky/emojery/commit/7f9aa8f3f9753122f7134848690ef5897d15c19e))
* **popup:** assemble the tabs behind one popup shell ([70021b4](https://github.com/khasky/emojery/commit/70021b4d2337e099685f1bfd686c7a428a1b4cb6))
* **reddit:** add the adapter ([81f73cd](https://github.com/khasky/emojery/commit/81f73cddbd066f460e20f8ad2489d3b56a42ac16))
* **settings:** add the popup settings view and its shared parts ([9deaba9](https://github.com/khasky/emojery/commit/9deaba995593c9ca8a2817e2286c5df796326bb6))
* **settings:** resolve the per-site settings and the stored counts ([0ad5a56](https://github.com/khasky/emojery/commit/0ad5a5676ced09fe209ff83ea2570d9c72797039))
* **shared:** add the helpers every layer leans on ([06a3ab0](https://github.com/khasky/emojery/commit/06a3ab0ed3c84ae5d34b83856f5cd170a3611f70))
* **shared:** carry every extension message over one typed envelope ([891468c](https://github.com/khasky/emojery/commit/891468c185dcfdf7f01794f83e6e8f46b906e4ae))
* **shared:** define the adapter contract and the injected DOM names ([0646e8f](https://github.com/khasky/emojery/commit/0646e8fc506905740edb3d71d667af565fcda985))
* **shared:** fetch and cache the emoji labels for the active locale ([004bfae](https://github.com/khasky/emojery/commit/004bfaefac57c23081a36db5bf0183a83d61ce6f))
* **shared:** keep the onboarding, recents and consent state ([0b453eb](https://github.com/khasky/emojery/commit/0b453eb9fcf450e85015f7a4fbb2219dc52e8d3a))
* **shared:** model a reaction and the emoji catalog ([0abbaeb](https://github.com/khasky/emojery/commit/0abbaeb2ca54b1624aca0000b0f6dd04fcfa440d))
* **shared:** resolve the API origin from the build mode ([06b349f](https://github.com/khasky/emojery/commit/06b349f34230b12f2b5a0761a085a5a86afa5b78))
* **sites:** add a content-script entrypoint per supported site ([5abc174](https://github.com/khasky/emojery/commit/5abc17444176d34b68e46199dd19709f75b0ebc2))
* **sites:** declare the registry of supported sites ([c3ea873](https://github.com/khasky/emojery/commit/c3ea873d010a306fb25d656ce6515e0d0b5dbfdf))
* **threads:** add the adapter ([bb5fcc3](https://github.com/khasky/emojery/commit/bb5fcc3bb620554bb22c5d53932046552edc694b))
* **trigger:** replace the native control with the emojery trigger ([bdefdf0](https://github.com/khasky/emojery/commit/bdefdf0e4cfef678009903013f1695f0b661d2ef))
* **vote:** send a reaction and mirror it across the open tabs ([ed35a61](https://github.com/khasky/emojery/commit/ed35a61984c0199dc2232d3024c0d5b2ebb3fd90))
* **x:** add the adapter ([735c50b](https://github.com/khasky/emojery/commit/735c50bd2148a6b8318a0f2b4d740cb5aa9f9ce4))
* **youtube:** add the adapter ([d853299](https://github.com/khasky/emojery/commit/d8532996dba4171bdef004ac3fa452e809305a12))


### Bug Fixes

* **auth:** show localized copy instead of the API error string ([b586cc4](https://github.com/khasky/emojery/commit/b586cc4d20507ce4149592d9cba6e78c6b516847))
* **background:** read /reactions/mine under the wire key ([4c8f2d5](https://github.com/khasky/emojery/commit/4c8f2d51cc1577c613151147efe8f395c80adc45))
* **badge:** show the toolbar dot only while an extension page is open ([be3ab7a](https://github.com/khasky/emojery/commit/be3ab7adf353193b1514c4ad313d77a2cc36894d))
* **build:** pin the build mode to the wxt subcommand ([fc13d68](https://github.com/khasky/emojery/commit/fc13d68d5b44989426e855c7661ba9f55c19722b))
* **i18n:** reword the sign-in gate and the coach tooltip ([30d5bcf](https://github.com/khasky/emojery/commit/30d5bcf437e25fd766a2dfbe34441061c388d41b))
* **onboarding:** tick the button step only for a trigger the user looked at ([e702e17](https://github.com/khasky/emojery/commit/e702e172497ce80d8283b8547ac2f316c319bda3))
* **picker:** keep Escape inside the open popover ([7ad214b](https://github.com/khasky/emojery/commit/7ad214b6830b50102c3f05399db27cd06c24758f))
* **vote:** scope the cross-tab delta to the target's own site ([fee43b5](https://github.com/khasky/emojery/commit/fee43b5f550d8ae832c797f3c4d94b4cfb780a5d))


### Refactoring

* collapse duplicated helpers and redundant work in the adapters and mount layer ([61325b3](https://github.com/khasky/emojery/commit/61325b36106c8ca7fa42f679907a55bc5cd5b32e))
* **mount:** move the style re-blend schedule into its own module ([1575daf](https://github.com/khasky/emojery/commit/1575dafa535e8a713cbe33ea01ac5c7426dd6c4d))
* **shared:** name every injected DOM selector once ([0b021ee](https://github.com/khasky/emojery/commit/0b021ee35d6f1ec837a3bc214697a55ec997f26b))
* **shared:** name the extensions own page DOM once ([7100c4c](https://github.com/khasky/emojery/commit/7100c4c09424555404ff41d4ea6973fed680fafa))
* **shared:** wait for a visible tab in one place ([68ead93](https://github.com/khasky/emojery/commit/68ead9395dbffffe587c3e70a8eb405c51875490))
