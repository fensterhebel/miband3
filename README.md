## miband3
A more extensive JS library for the Mi Band 3 and above

## Features
- device info (hardware, software)
- authentication
- send weather info
- get recent activity data
- set locale, time, date format, 24h format
- send notifications, missed calls, weather alerts
- send call and receive "answered" or "dismissed"
- set alarms and other events with recurring patterns (monthly, weekly, daily, ...)
- react on "silence phone" event
- set user data (height, weight, sex), right/left handed
- set daily steps goal
- get live accelration data

## Install
```
npm i miband3
```

## Example usage
```javascript
const { MiBand } = require('miband3')

const mac = 'FE:DC:BA:98:76:54'
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

MiBand.findDevice(mac).then(async (band) => {
  await band.connect()
  await band.authenticate(key)

  await band.vibrate()

  await band.setLocalTime()
  await band.setLocale('de_DE')
  await band.setDateFormat('dd.MM.yyyy')
  await band.set24h(true)

  await band.setDailyGoal(6000)
  await band.setVibrateWhenGoalReached(true)
  await band.setAlarm('10:05')
  await band.setScreenLock(false)

  console.log('battery:', await band.getBattery())
  console.log('steps:', await band.getSteps())
  console.log('activity:', await band.getActivity(Date.now() - 36e5)) // last 24 hours

  await band.disconnect()
  process.exit()
})
```

### Send weather data (using openweathermap.org)
You can get a free API key at [https://home.openweathermap.org/users/sign_up]
```javascript
const { MiBand, OpenWeatherMap } = require('miband3')
const mac = 'FE:DC:BA:98:76:54'
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

const weatherApi = new OpenWeatherMap({
  apiKey: <YOUR-API-KEY>, lang: 'en'
})
const weatherPromise = weatherApi.getWeather({
  place: 'Addis Ababa', lat: 9.03, lon: 38.74
})

MiBand.findDevice(mac).then(async (band) => {
  await band.connect()
  await band.authenticate(key)

  await band.setLocalTime()

  await band.sendWeather(await weatherPromise)

  await band.disconnect()
  process.exit()
})
```

### Process activity log (tracked steps, heartrate etc.)
```javascript
const { MiBand, TrackerDB } = require('miband3')
const mac = 'FE:DC:BA:98:76:54'
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

const activityLog = new TrackerDB()

MiBand.findDevice(mac).then(async (band) => {
  await band.connect()
  await band.authenticate(key)

  await band.setLocalTime()

  // retrieve activity data since the time when the current log ends
  const activityData = await band.getActivityRaw(activityLog.getNextDate())
  // write data to disk
  activityLog.saveData(activityData)

  // output activity of the last 60 minutes
  activityLog.getData(new Date(Date.now() - 60 * 6e4), 60)

  await band.disconnect()
  process.exit()
})
```

## ToDo
- testing on other OS than Linux
- "Don't disturb" mode
- continual heartrate monitoring
