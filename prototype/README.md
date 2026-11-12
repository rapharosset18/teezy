# Teezy (Swoosh look)

Clickable prototype of Teezy, a student ticket marketplace for USC: buy, haggle, sell and plan with friends. Everything is in `index.html` (vanilla HTML, CSS and JS, no build step). Data is made up and lives in memory; it resets on reload.

When rebuilding, keep the screens, flows and look exactly as they are.

## Look (Swoosh)

- Font: Archivo (Google Fonts). 900 for titles, 800 for buttons and labels, uppercase micro-labels with letter spacing.
- Colors (light): background `#FFFFFF`, surface-2 `#F2F2EC`, ink `#0E0E10`, ink-soft `#54555B`, lines `#E3E3DC`, accent orange `#FF6A13` with ink text on it (wash `#FFE9DB`), trust green `#17E88F`.
- Colors (dark): background `#0B0B0C`, surface `#141416`, surface-2 `#1B1B1E`, ink `#F5F5F1`, lines `#2A2A2C`, accent `#FF7A2B` (wash `#331B0C`), trust green `#2EFFA0`.
- 1.5px hairline borders, 14–16px card radius, pill chips. Selected chips and segmented controls are solid ink, and the selection slides between options. Primary buttons are orange with ink text. The active tab's icon sits on an orange square.
- Phone-sized app: framed on wide screens, full-bleed on phones.
- Theme: Settings › Theme switches Auto (follows the device), Light or Dark for the whole app, and remembers the choice.

## Motion

Keep these when rebuilding; they are a large part of how the app feels.

- Opening an event from a poster, a list row, a calendar row or a map pin grows that card into the event page, and Back shrinks it back to where it came from (Back runs a little slower, about half a second).
- Cards and tiles in the profile panel (for example Register an organization) grow into their page the same way.
- Opening a chat from the Inbox list pushes the chat in from the side, like a phone's own navigation; Back pushes it out.
- Tabs, Buy / Sell and other choices use a sliding pill, and the content under them slides in the same direction.
- Going Back returns to the scroll position you left, not the top of the page.

## Navigation

Bottom nav: My Tickets · Dashboard · Home · Inbox · Sell. Other screens push on top with a back button. The profile panel slides in from the avatar; screens and sheets opened from the panel return to the panel on Back or close (not to Home); location/dates, checkout, ticket, offers and settings open as bottom sheets.

## Screens and flows

- **Home**: one small location button (shows "Near USC" or the picked city) that opens a sheet with Near me (uses the device location), a city or campus search, distance and timeframe; each place has a pin that opens it in Google Maps. Then search, categories, offers banner, watchlist, then **Coming up**, a swipeable carousel of game posters (`assets/`), above the events near you with a map you can open full screen.
- **Event (game hub)**: the venue opens in Google Maps. A Buy / Sell toggle sits at the top. Buy: choose how many, best value together, name your price and send it to every matching seller, or post a request; tapping a seat opens a sheet with the seller's ask, your price slider and Buy or Offer, which grows into the deal and chat. Sell: what the game is going for, how fast your price would sell, a price slider that lists your ticket in place, requests you can fill right now, and your sales for that game.
- **Offers**: sellers counter or accept a few seconds after you offer (notification banner). Saved shows offer history with Chat / Counter / Accept, and the watchlist with each game's price trend.
- **Checkout**: payment is held by Teezy and released to the seller when you scan in at the gate.
- **My Tickets**: upcoming tickets (View, Sell, Transfer) with a real scannable QR code on each ticket, what you're selling, and **Past events** as a timeline: each one opens to show what you paid or made, who you went with and its album.
- **Sell**: pick a ticket, quick / suggested / top price, accept offers, payout after the event. Fill other students' requests.
- **Dashboard**: money held, on the way and ready (cash out), Needs you, stats, activity.
- **Inbox and chat**: filters, threads, Maya's negotiation with quick replies. A friend's chat (Ana) shows the event at the top and a ticket card in the conversation with Counter and Buy; she accepts a fair counter or meets you halfway.
- **Friends**: requests, plans, buy from friends. **My friend code** is a real QR code that opens the app with `?add=username`; anyone can scan it with their phone camera, and there is a Copy my link button.
- **Album**: join card, highlights, a filter by person, a photo grid, adding photos, and a full-screen viewer you swipe through, like and save from.
- **Register an organization**: a step-by-step flow (who you are, prove it with a code sent to the org email, how you get paid, review) with a progress bar; you can jump back to any step from the review.
- **Calendar**, **Edit profile**, **Settings**.

Club dues and memberships are not in this version; they come back later.
