# Philips Testuj Produkty: powiadomienia o nowych testach

Cloudflare Worker, który co 15 minut sprawdza https://testujprodukty.pl/testy i pisze na
Telegram (grupa „Philips Testowanie”, bot @FitnesiaraBot), gdy pojawi się nowy test do zgłoszenia.
Działa w darmowym planie Cloudflare.

- Powiadomienie zawiera nazwę produktu, termin zgłoszeń, liczbę nagród i link.
- Między 23:00 a 7:00 jest cisza nocna: testy z nocy przychodzą zbiorczo o 7:00, jeśli są jeszcze otwarte.
- Jeśli strona zmieni wygląd i nie da się znaleźć żadnych testów, Worker zgłasza błąd
  i nie rusza zapisanego stanu.

## Pliki
- `src/worker.js`: parser strony i logika powiadomień. `scheduled()` to cron, `/check?key=…` to ręczne sprawdzenie.
- `wrangler.toml`: cron, ID czatu, magazyn KV.
- Sekrety w Cloudflare: `TELEGRAM_BOT_TOKEN` i `CHECK_KEY`.

## Wdrażanie i logi
```bash
npx wrangler@4 deploy
```

```bash
npx wrangler@4 tail
```

## Zmiana czatu
Zmień `TELEGRAM_CHAT_ID` w `wrangler.toml` i zrób `deploy`. ID grupy znajdziesz w adresie
web.telegram.org (`#-123…`).
