# YouTube Transcript to PDF Exporter

A highly resilient Chrome Manifest V3 extension that converts YouTube video transcripts into readable, well-formatted PDFs entirely on the client side.

## Executive Summary

Unlike standard DOM-scraping extensions, this tool uses a dual-path extraction strategy. It primarily attempts to read caption-track metadata directly from YouTube's player response. If that fails, it gracefully falls back to scraping the visible transcript DOM. This ensures reliable extraction even when YouTube updates its UI.

The extension is strictly stateless. No backend, no `chrome.storage`, and no tracking. All transcript data is ephemeral and processed locally.

## Key Architecture Features

* **Caption-Track First:** Directly fetches JSON3/XML caption cues for the highest accuracy, bypassing UI restrictions.
* **Smart Fallback:** Uses DOM scraping as a secondary layer if network-level caption fetching is blocked.
* **Semantic Parsing:** Converts raw timed cues into structured, readable paragraphs, filtering out bracketed audio metadata (e.g., `[Music]`).
* **Zero Backend:** Uses a vendored `jsPDF` library to generate the PDF directly inside the extension popup.

## Installation for Developers

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle in the top right corner.
4. Click **Load unpacked**.
5. Select the extension directory containing the `manifest.json` file.

## Usage Workflow

1. Open any YouTube watch page.
2. Click the extension icon in your toolbar.
3. The UI will validate transcript availability.
4. Click **Export PDF**. 
5. The extension extracts the data, generates an A4 formatted PDF, and downloads it instantly.

## Technical Details

* **Permissions:** Uses `activeTab` and `scripting` to inject extraction logic without requiring broad host permissions.
* **Stateless Flow:** Passes semantic blocks (`h2`, `p`) directly from the content script to the popup for layout rendering.
