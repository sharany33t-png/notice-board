# Campus Digital Notice Board (Node.js + Express + Firebase Firestore)

Pages: Board (live display / kiosk), Notices (students), Admin (password protected).

## 1. Firebase setup (5 minutes)
1. console.firebase.google.com -> Add project (disable Google Analytics).
2. Build -> Firestore Database -> Create database -> production mode -> pick a region.
3. Project settings (gear icon) -> Service accounts -> Generate new private key. A .json file downloads. Keep it secret.

## 2. Run on your computer
    npm install
    set FIREBASE_SERVICE_ACCOUNT to the full contents of the .json file, and ADMIN_PASSWORD to your password
    npm start        then open http://localhost:3000

## 3. Deploy free on Render.com
1. Upload this folder to a GitHub repository.
2. Render -> New -> Web Service -> pick the repo. Build: npm install   Start: npm start
3. Environment variables:
   - ADMIN_PASSWORD = your password
   - FIREBASE_SERVICE_ACCOUNT = paste the entire contents of the downloaded .json file
4. Deploy, then open the https://....onrender.com link in Chrome.

Never upload the .json key file to GitHub.
