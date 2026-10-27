# Teezy (Swoosh look)

Clickable prototype of Teezy, a student ticket marketplace for USC: buy, haggle, sell, pay club dues and plan with friends. Everything is in `index.html` (vanilla HTML, CSS and JS, no build step). Data is made up and lives in memory; it resets on reload.

When rebuilding, keep the screens, flows and look exactly as they are.

## Look (Swoosh)

- Font: Archivo (Google Fonts). 900 for titles, 800 for buttons and labels, uppercase micro-labels with letter spacing.
- Colors (light): background `#FFFFFF`, surface-2 `#F2F2EC`, ink `#0E0E10`, ink-soft `#54555B`, lines `#E3E3DC`, accent lime `#D6FF3F` with ink text on it, trust green `#17E88F`.
- Colors (dark): background `#0B0B0C`, surface `#141416`, surface-2 `#1B1B1E`, ink `#F5F5F1`, lines `#2A2A2C`, accent `#E3FF5C`.
- 1.5px hairline borders, 14–16px card radius, pill chips. Selected chips and segmented controls are solid ink. Primary buttons are lime with an ink outline. The active tab's icon sits on a lime square.
- Phone-sized app: framed on wide screens, full-bleed on phones.
- Theme: Settings › Theme switches Auto (follows the device), Light or Dark for the whole app, and remembers the choice.

## Navigation

Bottom nav: My Tickets · Dashboard · Home · Inbox · Sell. Other screens push on top with a back button. The profile panel slides in from the avatar; screens and sheets opened from the panel return to the panel on Back or close (not to Home); location/dates, checkout, ticket, offers and settings open as bottom sheets.

## Screens and flows

- **Home**: one small location button (shows "Near USC" or the picked city) that opens a sheet with Near me, a city or campus search, distance (1 / 5 / 25 mi / Any) and timeframe (Today, This weekend, This week, This month, Pick dates); the section heading shows the place and timeframe. Then search, categories, offers banner, watchlist, events near you. **Coming up** is a swipeable carousel of game posters (`assets/`): one big portrait card at a time, the game name and listing count under it, dots that follow the card in view, and a lime **Buy now** button that opens that game. Other events follow as a list.
- **Event (game hub)**: Buy / Sell toggle. Choose how many, best value together, name your price and send it to every matching seller, or post a request. Full seat list leads to the seat page.
- **Seat**: asking vs. similar sales, seller, offer chips, Offer or Buy.
- **Offers**: sellers counter or accept a few seconds after you offer (notification banner). Saved shows offer history with Chat / Counter / Accept.
- **Checkout**: payment is held by Teezy and released to the seller when you scan in at the gate.
- **My Tickets**: Upcoming (View, Sell, Transfer), Passes (dues with pay or split in 3, parking), Selling (offers, edit price), Past (album).
- **Sell**: pick a ticket, quick / suggested / top price, accept offers, payout after the event. Fill other students' requests.
- **Dashboard**: money held, on the way and ready (cash out), Needs you, memberships, stats, activity.
- **Inbox and chat**: filters, threads, Maya's negotiation with quick replies.
- **Calendar**, **Friends** (requests, plans, buy from friends, albums), **Album**, **Register an organization**, **Settings**.
