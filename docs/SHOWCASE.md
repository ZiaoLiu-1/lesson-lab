# Public showcase

The project page is published at **https://ziaoliu.io/pages/lesson-lab/**. Its static source lives in `site/` and needs no build step, provider credential, backend, database or account.

The short film is the September 23 public edition of the interaction/delegation showcase. The separate 3:55 walkthrough explains the original study workflow and recorded comparison. Their timings and experiments remain separate; the page does not turn them into a general speedup claim.

## What this page does

- Introduces the independent Lesson Lab project and links to the public MIT source.
- Offers the short showcase and full walkthrough through click-to-load YouTube embeds, with direct YouTube links as a fallback.
- Points to the local application walkthrough, implementation and comparison method.

## What it does not do

- It does not send inference requests or use the author's API balance.
- It does not accept API keys, questions, uploads, microphone input or account details.
- It does not host the Node.js application or share local session state.

YouTube is a third-party service. An embedded player is created only after a visitor chooses to load it; the player may then make third-party requests. Direct video links open YouTube separately. No analytics or externally loaded fonts are added by the showcase page.

For the actual application, clone the repository, use Node.js 24+, and follow [DEMO.md](DEMO.md). Live edits require your own provider access; keep credentials in the local server environment. The public showcase and the local application are deliberately separate.

## Static hosting

Serve only the contents of `site/` for this page. Do not publish the repository root as a generic file directory, and never copy `.env`, `.local`, recordings or private source into it. The existing Studio and benchmark entry points are unchanged.
