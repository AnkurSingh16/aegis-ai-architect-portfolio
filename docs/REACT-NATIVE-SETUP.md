# React Native / Expo — Phase 2

The starter intentionally **does not create `apps/mobile`** so `create-expo-app` can create that folder cleanly: SDK versions and the workflow for physical iPhone vs Simulator differ in Oct 2026. Build the core web/API first.

When ready, choose a device path and run from the repo root:

```bash
# iOS Simulator: install Xcode and its Simulator components first.
npx create-expo-app@latest apps/mobile --template default@sdk-58
cd apps/mobile
npx expo start --ios
```

For a physical iPhone, first check Expo's SDK compatibility and Apple Developer/TestFlight requirements. Add `apps/mobile` as an npm workspace only after verifying its generated package.json and Expo requirements.

The mobile app will consume the **same authenticated API** as the React web app once OAuth/OIDC is implemented. Never embed OpenAI API secrets in a mobile build.
