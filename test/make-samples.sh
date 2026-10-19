#!/usr/bin/env bash
# Tworzy próbne pliki w każdym obsługiwanym formacie wejściowym (wymaga ffmpeg w systemie).
#   bash test/make-samples.sh <folder>
set -e
OUT="${1:?Podaj folder na próbki}"
mkdir -p "$OUT" && cd "$OUT"
F="ffmpeg -hide_banner -loglevel error -y"
V="-f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 4"
$F $V -c:v libx264 -pix_fmt yuv420p -c:a aac v_h264.mp4
$F $V -c:v libx265 -pix_fmt yuv420p10le -c:a libopus v_hevc10.mkv
$F $V -c:v libvpx-vp9 -deadline realtime -c:a libopus v_vp9.webm
$F $V -c:v mpeg4 -c:a libmp3lame v_mpeg4.avi
$F $V -c:v libx264 -pix_fmt yuv420p -c:a aac v_h264.mov
$F $V -c:v flv1 -c:a libmp3lame -ar 44100 v_flv.flv
$F $V -c:v mpeg2video -c:a mp2 v_mpeg2.ts
$F -f lavfi -i testsrc2=size=640x360:rate=25 -t 3 -c:v libx264 -pix_fmt yuv420p v_noaudio.mp4
A="-f lavfi -i sine=frequency=330:sample_rate=44100 -t 4"
$F $A a.mp3; $F $A a.wav; $F $A a.flac; $F $A -c:a libvorbis a.ogg; $F $A -c:a aac a.m4a
$F $A -c:a libopus a.opus; $F $A -c:a wmav2 a.wma; $F $A a.aiff
$F -f lavfi -i testsrc2=size=800x600 -frames:v 1 i.png
$F -i i.png i.jpg; $F -i i.png i.bmp; $F -i i.png i.tiff; $F -i i.png -c:v libwebp i.webp
$F -f lavfi -i testsrc2=size=320x240:rate=10 -t 2 i_anim.gif; $F -i i.png -vf scale=64:64 i.ico
$F -i i.png -c:v libaom-av1 -still-picture 1 -cpu-used 8 i.avif || true
echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#ff4fa6"/></svg>' > i.svg
echo "Próbki w: $OUT"
