# Ringtone easter egg - closed, do not re-investigate

Long-press easter egg in js/input.js hands over a pre-rendered theme file as a
ringtone (docs/snake-theme.m4r 5.000s / docs/snake-theme-classic.m4r 6.000s,
ONE loop each). test/render-theme.js renders them from the same SEQ table
js/audio.js plays and folds the notes still ringing at the cut back onto the
head, so one loop repeats seamlessly (proved numerically: one-loop tiled twice
equals a real two-loop render, max diff 0.0).

Both routes are field-verified on real devices - iOS (navigator.share -> SAVE
TO FILES -> Files > share > RINGTONE) and Android (plain blob download to
Downloads, .m4a). Do not re-investigate either route.

Re-encoding gotcha: needs `-f ipod` - ffmpeg has no output format registered
for the .m4r name and refuses it outright. .m4r and .m4a are the identical
AAC-in-MP4 file; only the name decides which importer opens it.
See feedback_fok_audio_changes.md.
