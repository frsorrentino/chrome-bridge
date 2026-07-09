# Checklist submission Chrome Web Store

## 0. Prerequisiti (una tantum)

- [ ] Account Google da usare come developer (consigliato: quello personale principale)
- [ ] Registrazione su https://chrome.google.com/webstore/devconsole → accetta il Developer Agreement → paga $5 (carta richiesta)
- [ ] (Consigliato) In "Account" compila publisher name ed email di contatto, verifica l'email

## 1. Upload pacchetto

- [ ] Genera lo zip: `scripts/package-extension.sh` → `dist/chrome-bridge-extension-1.5.0.zip`
- [ ] Dev Console → "New item" → carica lo zip

## 2. Tab "Store listing"

Da `docs/store/listing.md`:
- [ ] Title: Chrome Bridge for Claude Code
- [ ] Summary: (riga Summary)
- [ ] Description: (sezione Detailed description)
- [ ] Category: Developer Tools · Language: English
- [ ] Screenshot: carica i 3 PNG 1280×800 da `docs/store/screenshots/`
- [ ] Small promo tile 440×280: `docs/store/promo-tile-440x280.png`
- [ ] Homepage URL e Support URL (sezione URLs)

## 3. Tab "Privacy practices"

- [ ] Single purpose: incolla da `docs/store/listing.md`
- [ ] Permission justifications: incolla ogni voce da `docs/store/permissions-justifications.md` (inclusa host permission e remote code)
- [ ] Data usage: nessuna categoria selezionata + spunta le 3 certificazioni
- [ ] Privacy policy URL: https://frsorrentino.github.io/chrome-bridge/privacy

## 4. Tab "Distribution"

- [ ] Visibility: Public
- [ ] Distribution: tutti i paesi (default)

## 5. Submit

- [ ] "Submit for review". Non spuntare la pubblicazione differita (publish automatically appena approvato va bene)
- [ ] Tempi attesi: da ore a ~1-2 settimane (permessi ampi = coda review manuale)

## 6. Se arriva un rigetto

- Leggi il motivo esatto nell'email (codice violazione, es. "Blue Argon" = remote code, "Purple Potassium" = permessi non giustificati)
- Rispondi/correggi e risottometti: i rigetti al primo giro sono normali per estensioni con permessi ampi
- Non ricreare l'item da zero: risottometti lo stesso, la storia review aiuta
