# RecruitMe Opera LinkedIn Capture

Load this folder as an unpacked extension in Opera or any Chromium-based browser.

## Install

1. Open `opera://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder:

```text
browser-companion/recruitme-chrome-extension
```

## Usage

- In RecruitMe, click **Fetch profile** on a candidate card.
- RecruitMe creates a pending capture session and opens LinkedIn.
- This extension detects the pending session, captures the rendered LinkedIn profile, and posts it back to RecruitMe automatically.

The popup also supports manual imports:

- Open a LinkedIn profile
- Click the extension icon
- Choose a job
- Click **Import current LinkedIn profile**

## Connection requirements

The extension always needs the correct RecruitMe server URL. The automatic `Fetch profile` flow does not need popup credentials.

- Open the extension popup
- Enter the same RecruitMe server URL
- Add your RecruitMe username and password only if you want to use manual import from the popup
- Click **Save and test connection**
