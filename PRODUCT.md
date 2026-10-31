# couch

Watch a film together from two places, in sync, without screen sharing.

## What it is

Two people open the same bookmarked room at couch.nicktrim.com. The film is a
plain MP4 that both browsers play in an ordinary `<video>`; a Cloudflare
Durable Object relays play, pause and seek between them, exactly.

The film comes from the host's Mac: `cine couch <title>` (in the cine repo)
picks a film and a torrent every browser can play (MP4, H.264), streams it
with rqbit, serves only that file and its English subtitles from a gatekeeper
behind a random token, and opens an anonymous Cloudflare quick tunnel to it.
It tells the room the film and the tunnel URL. Everything lives as long as
that command runs. The other person only ever opens the room link.

Voice stays outside the app: an audio-only call, with headphones on.

## How a night goes

1. Both open the room bookmark and press **sit down**.
2. The host runs `cine couch <title>` (or presses `c` on a film in cine's
   Stream tab), picks the film and a source. It appears for both of you.
3. Watch. The pill shows who is here, the clock, an English subtitles toggle
   (per person) and whether you are in sync; more than 3 s apart turns it
   magenta with a Resync button.
4. At the end both land on a details page and rate it 1 to 5 blind. **Done**
   returns to the empty room. cine shuts the tunnel when the film ends, or on
   Ctrl-C.

## Decisions that matter

- No third-party player and no scraping: the file is ours, served from the
  host's Mac. The vidlink-based first version (iframe, reload sync, a proxy
  that stripped its ads) was deleted for being the most fragile thing built.
- A media event is only reported when it disagrees with the room. Followers
  seek 1.5 s ahead when the room is playing (the jump re-buffers through the
  tunnel); seeks within 2.5 s of the room count as following, not a person.
- Everyone, the host included, streams through the tunnel: a public page
  reading this Mac's 127.0.0.1 makes Chrome ask for local network access.
- The room only accepts `*.trycloudflare.com` stream URLs and IMDb ids. If the
  source disconnects, the film stays, paused; the same film returning resumes.
- Film details come from Wikidata and Wikipedia by IMDb id (IMDb itself
  refuses Cloudflare's servers). No IMDb rating is shown, by choice.
- Movies only.

## Known limits

- The host's Mac must stay awake and online for the whole film (cine runs
  `caffeinate` while it streams). It runs on the host's mobile hotspot today:
  1080p is about 2 GB down for the torrent plus 2 GB up per viewer.
- Films without an MP4 H.264 release can't be couch films; cine says so.
- Quick tunnels come without an uptime guarantee from Cloudflare.

## Where it is headed

- A shared history of finished films, from the ratings already stored.
