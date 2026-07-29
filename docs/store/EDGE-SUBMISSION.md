# Submission Microsoft Edge Add-ons

Stesso pacchetto della CWS: `dist/chrome-bridge-extension-1.8.0.zip`. Nessuna modifica al manifest necessaria (MV3 standard, niente API Chrome-only; `userScripts` ha check di disponibilità con degradazione, quindi anche se Edge non lo espone l'estensione resta funzionante).

## Passi

1. **Registrazione account** (una tantum, gratuita): https://partner.microsoft.com/dashboard/microsoftedge/public/login — accedi con account Microsoft. Nessuna fee di registrazione per il programma Edge.
2. **New extension** → carica `dist/chrome-bridge-extension-1.8.0.zip`.
3. **Listing**: riusa i blocchi di `PASTE-SHEET.md` (Title, Summary, Description sono identici — il form Edge ha campi equivalenti). Screenshot: `docs/store/screenshots/`.
4. **Privacy**: stessa privacy policy URL della CWS (https://frsorrentino.github.io/chrome-bridge/privacy).
5. **Notes for certification** (campo per i revisori) — incolla:

```
This extension is the browser side of an open-source MCP bridge (https://github.com/frsorrentino/chrome-bridge).
It connects ONLY to a local WebSocket server on localhost:8765 that the user installs and runs on their own machine
(no remote servers, no accounts, no data collection).
To test: clone the repo, run ./install.sh, start the server with `node server/index.js`, then load the extension.
The popup shows connection status; without the local server the extension is idle and harmless.
```

6. Invia. Tempi di revisione tipici: fino a ~7 giorni lavorativi.

## Dopo la pubblicazione

- Aggiungi il link Edge Add-ons a `README.md` e `docs/index.md` accanto al link CWS.
- Ricordati di aggiornare ANCHE il pacchetto Edge a ogni release futura (due store da mantenere).
