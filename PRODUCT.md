# couch

Watch a film together from two places, in sync, without screen sharing.

## What it is

Two people open the same bookmarked room at couch.nicktrim.com. Each browser
plays its own copy of the film from vidlink's embed, so nothing is encoded or
uploaded and laptops stay cool. A Cloudflare Durable Object relays play,
pause and seek between the two. When one person acts, the other person's
player reloads at the right second.

Voice stays outside the app: an audio-only call, with headphones on.

## How a night goes

1. Open the room bookmark and press **sit down** (that click lets the
   player autoplay; vidlink still mutes it when it does).
2. Search for the film in the empty room (Wikidata, films only) and pick it.
   A pasted 1shows link still works, but nobody has to visit 1shows and its ads.
3. Watch. The pill in the top right shows who is here and whether you are in
   sync. Drifting more than 3 s apart turns it magenta with a Resync button.
4. When the film ends, both of you land on a details page, rate it 1 to 5
   blind, and reveal together. **Done** returns to the empty room.

## Decisions that matter

- vidlink takes no commands, only reports events, so remote control works by
  reloading the iframe with `startAt`.
- vidlink runs in JW mode (`player=jw`): its default player restores its own
  saved time over `startAt`. `startAt` is always at least 2, because vidlink
  ignores 0 and 1.
- A player event only counts as a person if it changes something: a `play`
  while the room already plays is the player starting after a buffer.
- Seeks are spotted as jumps between two of our own player's time reports,
  never from the `seeked` event (JW sends it before the jump, with the old
  time) and never against the room clock (a seat that loaded late would read
  its lag as a seek, and the two seats would bounce each other forever).
- Film details come from Wikidata, IMDb and Wikipedia. IMDb refuses
  Cloudflare's servers, so in production the page uses Wikidata and
  Wikipedia. No IMDb rating is shown, by choice.
- Movies only. No TV episodes.

## Known limits

- Use a Chromium browser (Chrome, Edge, Brave, Arc) on both ends. vidlink
  serves most films as H.265 MP4s tagged `hev1`, every quality included.
  Safari only plays `hvc1`, and Firefox/Zen has no H.265 on macOS, so both
  fail with JW error 241001. The gate warns when the browser can't decode it.

- vidlink opens betting-ad pop-ups on the first clicks inside its player.
  An ad blocker on either laptop removes them.
- Each remote action costs the other person a 2-5 s reload.
- vidlink forces mute whenever it autoplays, so after the other person
  presses play or seeks, your player resumes muted and you click its speaker.
  Fixing that needs direct control of the player (see below).
- Not tested in real Chrome or Safari with two people yet; headless tests
  covered the relay, reloads, toasts, drift and the end page.

## Where it is headed

- Direct player control, by serving vidlink's player page from couch's own
  origin: no reloads, no forced mute, ads stripped. Blocked in part because
  vidlink's DASH streams refuse other origins (403); MP4 sources play.
- Season and episode picker for TV, if they start watching series.
- A shared history of finished films, from the ratings already stored.
