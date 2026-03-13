# ytm-lyrics

A Chrome extension that shows lyrics for whatever is playing on YouTube Music.

## Why I made this

I listen to a lot of music on YouTube Music while working on my laptop. The problem is there is no way to see lyrics without switching tabs or opening some other app. I wanted something that just sits on screen and shows the lyrics as the song plays, without me having to do anything.

So I built this. It shows a small floating panel with the lyrics, and it follows along with the song automatically. If I am on a different tab, the panel is still there. If I open it in a separate window, I can move it to the side of my screen and have the lyrics up while I do other things.

## What it does

- Shows lyrics for the current song playing on YouTube Music
- The lyrics scroll and highlight the current line as the song plays
- The panel floats over any page you are on, not just YouTube Music
- You can also open the lyrics in a separate popup window, which is useful if you have a second monitor or just want it out of the way
- Click on any line in the lyrics to jump to that part of the song
- You can drag the overlay around and it remembers where you left it
- Lyrics are cached so it does not keep making requests for the same song

## How it works

The extension watches YouTube Music for the currently playing track. When a song starts, it fetches the lyrics from [lrclib.net](https://lrclib.net), which is a free lyrics API. If synced lyrics are available it uses those, otherwise it falls back to plain lyrics. The lyrics are then shown in the floating overlay or the popup window, whichever you have open.

## Installation

This is not on the Chrome Web Store. You need to load it manually.

1. Download or clone this repo
2. Open Chrome and go to `chrome://extensions`
3. Turn on "Developer mode" in the top right
4. Click "Load unpacked" and select the folder where you downloaded this

That's it. Open YouTube Music and play a song.

## Usage

Once installed, the lyrics overlay will appear automatically when a song is playing. You can:

- Close the overlay with the X button
- Collapse it to a small bar with the arrow button
- Drag it anywhere on screen
- Click the extension icon in the toolbar to toggle the overlay or open a floating window

## Notes

- Lyrics come from lrclib.net. If a song is not found there, it will show "Lyrics not found"
- The extension only activates on music.youtube.com
- No data is collected or sent anywhere except to lrclib.net to fetch lyrics

## Tech

Chrome Extension Manifest V3, plain JavaScript, no frameworks.
