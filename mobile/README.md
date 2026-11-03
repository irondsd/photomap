# Photomap Sync

An Android app that sends the photos and videos on your phone to [Photomap](../README.md#phone-sync) over wifi. It reads the phone's media library directly, with the media-location permission, so files arrive as originals with their GPS intact. A web page can't do that, because the browser's photo picker strips locations.

Built with Expo (SDK 58). It's a standalone project with its own dependencies; run everything below from `mobile/`.

## Setup (once)

You need a JDK 17 and the Android SDK:

```bash
brew install --cask zulu@17 android-commandlinetools
```

```bash
yes | sdkmanager --licenses
```

```bash
sdkmanager "platform-tools" "platforms;android-37" "build-tools;37.0.0" "ndk;27.1.12297006"
```

These versions come from `node_modules/react-native/gradle/libs.versions.toml`. Gradle downloads any it's missing once the licenses are accepted.

Then add to your shell profile:

```bash
export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
```

Installing Android Studio instead works too (it includes both). Set `ANDROID_HOME=~/Library/Android/sdk` in that case.

On the phone, enable **Developer options → USB debugging**, connect it, and accept the prompt. `adb devices` should list it.

## Run

```bash
bun install
bun run android                 # debug build on the connected phone, with live reload from this Mac
bun run android:release         # standalone build that runs without the Mac
```

The app won't run in Expo Go, which doesn't have full media library access on Android. The commands above build it with your local SDK. `android/` is generated on each build and isn't checked in. Configure native settings in `app.json`.

## Checks

```bash
bun test              # sync engine, pairing, formatting
bun run typecheck
bun run doctor        # expo-doctor: SDK-compatible dependency versions
```

`src/protocol.ts` is a copy of the server's `src/sync/protocol.ts`, and a server test fails if they differ. Change both together.
