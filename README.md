# miband3
A more extensive JS library for the Mi Band 3 and above

# example usage
```javascript
const { MiBand } = require('./src/index')

const mac = 'FE:10:31:25:9A:A2'
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
