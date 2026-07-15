# Payment Verifier — CBE & telebirr

Verify Ethiopian payment receipts (Commercial Bank of Ethiopia & telebirr) by scanning or uploading a receipt screenshot. The app reads the QR code on the receipt, pulls the **official record from the CBE / telebirr servers**, and cross-checks it against the image — so a photoshopped screenshot gets flagged.

## Features
- 📸 Camera scan or image upload (drag & drop supported)
- ✅ 100% verification against official CBE (`mbreciept.cbe.com.et` / `apps.cbe.com.et`) and telebirr (`transactioninfo.ethiotelecom.et`) servers
- 🔍 OCR fallback + tamper detection (image vs. bank record mismatch)
- Shows amount, total debited with fees, time sent, payer, receiver, transaction ID, and status

## Run

```bash
npm install
npm start
```

Open http://localhost:3311

## Notes
- Old-style CBE "Thank You" receipts embed only the transaction ID in the QR; CBE's system requires the last 8 digits of the sender or receiver account to release the official record — enter them in the optional field.
- Requires internet access to reach the CBE/telebirr verification servers.
