'use strict'
const noble = require('@abandonware/noble')
const crypto = require('crypto')
const { UInt16, UInt32, MiDate, parseActivity } = require('./helpers')

const OpenWeatherMap = require('./openweathermap')
const TrackerDB = require('./trackerdb')

const DEBUG = false

const END = -1

const delay = ms => new Promise(res => setTimeout(res, ms))
const concat = (...value) => Buffer.concat(value.map(v => v instanceof Buffer ? v : Buffer.from(v)))

class MiBand {
  static async findDevice (mac, timeout = 30000) {
    return new Promise((res) => {
      timeout = setTimeout(() => {
        noble.stopScanning()
        throw new Error('[search] timeout')
      }, timeout)
      const onDiscover = (peripheral) => {
        console.log('[search] found', peripheral.address)
        if (peripheral.address === mac.toLowerCase()) {
          clearTimeout(timeout)
          noble.stopScanning() // seems to be ignored
          noble.removeListener('discover', onDiscover)
          res(new this(peripheral))
        }
      }
      noble.on('discover', onDiscover)
      noble.startScanning()
    })
  }

  constructor (device, options = {}) {
    this.device = device
    this.timeZone = -new Date().getTimezoneOffset()
    this.place = 'Home'
    Object.assign(this, options)
  }

  async connect (options = {}) {
    Object.assign(this, options)
    await this.device.connectAsync()
    console.log('[MiBand] connected')
    Object.assign(this, await this.device.discoverAllServicesAndCharacteristicsAsync())
    console.log('[MiBand] initialized')
    // console.log('characteristics', this.characteristics.map((char) => ({
      // uuid: char.uuid.length <= 4 ? char.uuid : char.uuid.substr(4, 4),
      // name: char.name,
      // type: char.type ? char.type.split('.').pop() : null,
      // properties: char.properties
    // })))
    return this
  }

  async disconnect () {
    await this.device.disconnectAsync()
    console.log('[MiBand] disconnected')
    // leaves process running, therefore call: process.exit()
  }

  char (type_or_uuid) {
    const char = this.characteristics.find((c) => {
      if (c.type && c.type.split('.').pop() === type_or_uuid) {
        return true
      }
      if (c.uuid) {
        const uuid = c.uuid.length > 4 ? c.uuid.substr(4, 4) : c.uuid
        return uuid === type_or_uuid
      }
      return false
    })
    if (!char) {
      throw new Error('characteristic not found: ' + type_or_uuid)
    }
    return char
  }

  read (type_or_uuid) {
    return this.char(type_or_uuid).readAsync()
  }

  waitNotify (type_or_uuid, timeout = 10000, ...value) {
    return new Promise(async (resolve) => {
      if (timeout) {
        timeout = setTimeout(() => resolve(), timeout)
      }
      const char = this.char(type_or_uuid)
      await char.subscribeAsync()
      char.once('data', (data) => {
        if (timeout) clearTimeout(timeout)
        resolve(data)
      })
      if (value && value.length) {
        await this.write(type_or_uuid, ...value)
      }
    })
  }

  write (type_or_uuid, ...value) {
    const data = Buffer.concat(value.map(v => v instanceof Buffer ? v : Buffer.from(v)))
    if (DEBUG) console.log(type_or_uuid, data)
    const char = this.char(type_or_uuid)
    return char.writeAsync(data, char.properties.includes('writeWithoutResponse'))
  }

  writeAndListen (type_or_uuid, initialWrite, callback, maxDelay = 2000) {
    return new Promise(async (resolve) => {
      let timeout
      const char = this.char(type_or_uuid)
      const onData = (data) => {
        if (DEBUG) console.log('[' + type_or_uuid + ']', data)
        if (timeout) {
          clearTimeout(timeout)
        }
        let reply = callback(data)
        if (reply) {
          if (reply === END) {
            char.removeListener('data', onData)
            return resolve()
          }
          if (typeof reply[0] !== 'object') {
            reply = [reply]
          }
          this.write.call(this, type_or_uuid, ...reply)
        }
        timeout = setTimeout(() => resolve, maxDelay)
      }
      await char.subscribeAsync()
      char.on('data', onData)
      if (initialWrite) {
        if (typeof initialWrite[0] !== 'object') {
          initialWrite = [initialWrite]
        }
        await this.write(type_or_uuid, ...initialWrite)
      }
    })
  }

  async authenticate (key) {
    await this.writeAndListen('0009', [0x01, 0x00], (data) => {
      const cmd = data.toString('hex', 0, 3)
      if (cmd === '100104') {
        // 0x01 0x00 0x1a (pair?)
        return [0x02, 0x08]
      } else if (cmd === '100101') {
        // 0x02 0x00 0x02 (the same?)
        // request random number
        return [0x02, 0x08]
      } else if(cmd === '100201') {
        // reply encrypted received random number
        const randomNumber = data.slice(3)
        const encrypted = crypto.createCipheriv('aes-128-ecb', key, null).update(randomNumber)
        return [[0x03, 0x08], encrypted]
      } else if(cmd === '100301') {
        // success!
        console.log('[MiBand] authenticated')
        return END // unsubscribe
      } else if(cmd === '100304') {
        // key failure
        return [[0x01, 0x08], key]
      } else {
        console.error('[Auth] received:', data)
        throw new Error('[Auth] unknown response')
      }
    })
    return this
  }

  async getInfo () {
    return {
      softwareRevision: (await this.read('2a28')).toString(),
      hardwareRevision: (await this.read('2a27')).toString(),
      serialNumber: (await this.read('2a25')).toString(),
      systemId: (await this.read('2a23')).toString('hex'),
      pnpId: (await this.read('2a50')).toString('hex')
    }
  }

  async getLocalTime (asMiDate = false) {
    const time = await this.read('current_time')
    if (DEBUG) console.log('getting time:', new MiDate(time).toString())
    return asMiDate ? new MiDate(time) : new MiDate(time).toString()
  }

  async getSteps () {
    const response = await this.read('0007')
    if (response[0] === 0x0c) {
      return {
        steps: response.readUInt32LE(1),
        meters: response.readUInt32LE(5),
        kcal: response.readUInt32LE(9)
      }
    } else {
      console.error('unkown response:', response)
    }
  }

  async getBattery () {
    const response = await this.read('0006')
    if (DEBUG) console.log(response)
    return {
      level: response[1],
      charging: !!response[2],
      last_charge: {
        date: new MiDate(response.slice(11, 19)).toString(),
        level: response[19]
      },
      last_fullcharge: {
        date: new MiDate(response.slice(3, 11)).toString(),
        level: 100 // obviously
      }
    }
  }

  async getPulse () {
    // 0x15 0x03 0x00 ?
    // await this.write('2a39', [0x15, 0x01, 0x00])
    await this.write('2a39', [0x15, 0x02, 0x01])
    const response = await this.waitNotify('2a37', 20000)
    await this.write('2a39', [0x15, 0x02, 0x00])
    if (response[0] !== 0x00) {
      return false
    }
    return response[1]
  }

  async setLocalTime (date = null) {
    date = date instanceof MiDate ? date : new MiDate(date || new Date(), this.timeZone)
    if (DEBUG) console.log('setting time:', date.toString())
    await this. write('current_time', date.toBuffer('YmdHisw00e'))
  }

  async set24h (yesno) {
    await this.write('0003', [0x06, 0x02, 0x00, +!!yesno])
  }

  async setImperialUnits (yesno) {
    await this.write('0003', [0x06, 0x03, 0x00, +!!yesno])
  }

  async setDateFormat (format) {
    // format: MM/dd/yyyy, dd.MM.yyyy
    await this.write('0003', [0x06, 0x1e, 0x00], format, [0x00])
  }

  async setLocale (locale) {
    // en_US, de_DE
    await this.write('0003', [0x06, 0x17, 0x00], locale)
  }

  async setDailyGoal (steps) {
    await this. write('0008', [0x10, 0x00, 0x00], UInt16(steps), [0x00, 0x00])
  }

  async setUserInfo (birthday, isFemale, height, weight, id) {
    birthday = birthday instanceof MiDate ? birthday : new MiDate(birthday, this.timeZone)
    await this.write('0008', [0x4f, 0x00, 0x00], birthday.toBuffer('Ymd'), [+!!isFemale], UInt16(height), UInt16(weight * 200), UInt32(id))
  }

  async setAlarm (time, slot = 0, rhythm = 0x80, snooze = false) {
    // rhythm: 0x80 once, 0x01 Monday, 0x02 Tuesday, 0x04 Wednesday
    if (!time) {
      // delete
      rhythm = 0x00
    } else {
      time = time instanceof MiDate ? time : new MiDate(time, this.timeZone)
    }
    await this.write('0003', [0x02, !!rhythm * (0xc0 - 0x40 * snooze + slot)], time ? time.toBuffer('Hi') : [0x00, 0x00], [rhythm || 0x80])
  }

  async setEvent (datetime, title, slot = 0, rhythm = 0x00) {
    // rhythm: 0x00 once, 0x01 Monday, 0x02 Tuesday, 0x04 Wednesday, ..., 0x80 monthly, 0x100 yearly, 0x7f daily (sum of all single days), -1 weekly automatic weekday
    if (!datetime || !title) {
      // delete
      await this.sendChunkedData(2, [0x0b, slot, 0x00, 0x00, 0x00, 0x00])
      return
    }
    datetime = datetime instanceof MiDate ? datetime : new MiDate(datetime, this.timeZone)
    if (rhythm === -1) {
      // weekly, but calculate weekday automatically
      rhythm = 1 << ((datetime.getDayOfWeek() + 6) % 7)
    }
    await this.sendChunkedData(2,
      [0x0b, slot], UInt16(0x09 + (rhythm << 5)), [0x00, 0x00], datetime.toBuffer('YmdHis'), title, [0x00]
    )
  }

  async setInactivityWarning (start, end, pauseStart, pauseEnd) {
    const times = []
    if (end) {
      start = start instanceof MiDate ? start : new MiDate(start, this.timeZone)
      end = end instanceof MiDate ? end : new MiDate(end, this.timeZone)
      times.push(start.toBuffer('Hi'), end.toBuffer('Hi'))
    } else {
      times.push([0x00, 0x00, 0x00, 0x00])
    }
    if (pauseEnd) {
      pauseStart = pauseStart instanceof MiDate ? pauseStart : new MiDate(pauseStart, this.timeZone)
      pauseEnd = pauseEnd instanceof MiDate ? pauseEnd : new MiDate(pauseEnd, this.timeZone)
      times.splice(1, 0, pauseStart.toBuffer('Hi'), pauseEnd.toBuffer('Hi'))
    } else {
      times.push([0x00, 0x00, 0x00, 0x00])
    }
    await this.write('0003', [0x08, +!!start, 0x3c, 0x00], ...times)
  }

  async setDontDisturbMode () {
    // ToDo
    // await this.write('0003', [0x09])
  }

  async setScreenLock (yesno) {
    await this.write('0003', [0x06, 0x16, 0x00, +!!yesno])
  }

  async setVisibility (yesno) {
    await this.write('0003', [0x06, 0x01, 0x00, +!!yesno])
  }

  async setAllowNearbyPulseRead (yesno) {
    await this.write('0003', [0x06, 0x1f, 0x00, +!!yesno])
  }

  async setDisableNewPairing (yesno) {
    await this.write('0003', [0x06, 0x20, 0x00, +!!yesno])
  }

  async setNightMode (start, end) {
    if (end) {
      start = start instanceof MiDate ? start : new MiDate(start, this.timeZone)
      end = end instanceof MiDate ? end : new MiDate(end, this.timeZone)
      await this.write('0003', [0x1a, 0x01], start.toBuffer('Hi'), end.toBuffer('Hi'))
    } else {
      await this.write('0003', [0x1a, !!start * 0x02])
    }
  }

  async setActivateDisplayOnGesture (start, end) {
    if (end) {
      start = start instanceof MiDate ? start : new MiDate(start, this.timeZone)
      end = end instanceof MiDate ? end : new MiDate(end, this.timeZone)
      await this.write('0003', [0x06, 0x05, 0x00, 0x01], start.toBuffer('Hi'), end.toBuffer('Hi'))
    } else {
      await this.write('0003', [0x06, 0x05, 0x00, +!!start, 0x00, 0x00, 0x00, 0x00])
    }
  }

  async setVibrateWhenGoalReached (yesno) {
    await this.write('0003', [0x06, 0x06, 0x00, +!!yesno])
  }

  async setMenu (order = 'CM') {
    // C clock
    // N notifications
    // W weather
    // E training (exercise)
    // M more
    // S status
    // H heartbeat
    // T timer
    if (!order.includes('C')) {
      order = 'C' + order
    } else if (!order.startsWith('C')) {
      order = 'C' + order.split('C').reverse().join('')
    }
    let menu = []
    let mask = ''
    for (const item of 'CNWEMSHT') {
      let p = order.toUpperCase().indexOf(item)
      if (p < 0) {
        p = order.length
        order += item.toLowerCase()
      }
      menu.push(p)
      mask = +order.includes(item) + mask
    }
    await this.write('0003', [0x0a, parseInt(mask, 2), 0x30], menu)
  }

  async setWearingSide (isRightSide) {
    await this.write('0008', [0x20, 0x00, 0x00, 0x02 + 0x80 * +!!isRightSide])
  }

  async sendChunkedData (channel, ...value) {
    const wrap = 17 // 32 Bytes - 12 BT Protocol - 3 Overhead
    const buffer = concat(...value)
    const char = this.char('0020')
    return await new Promise(async (resolve) => {
      await char.subscribeAsync()
      char.once('data', (data) => {
        if (DEBUG) console.log('[0020←]', data)
        if (data[data.length - 1] === 0x01) {
          resolve(true)
        } else {
          console.error('[0020] error:', data)
          resolve(false)
        }
      })
      for (let i = 0; i * wrap < buffer.length; i++) {
        const mode = (buffer.length <= wrap) * 0x80 + (i > 0) * 0x40 + ((i + 1) * wrap >= buffer.length) * 0x40
        await this.write('0020', [0x00, mode + channel, i], buffer.slice(i * wrap, Math.min(buffer.length, (i + 1) * wrap)))
      }
    })
  }

  async sendCall (name = null) {
    if (name === '') {
      // anonymous call
      await mi.write('alert_level', [0x02, 0x01])
    } else {
      await this.sendChunkedData(0, [0x03, !!name], name || '', [0x00, 0x00, 0x00])
    }
    const response = await this.waitNotify('0010')
    if (response[0] === 0x09) {
      return true
    } else if (response[0] === 0x07) {
      return false
    } else {
      console.error('unknown response:', response)
    }
  }

  async sendMissedCall (name) {
    await this.sendChunkedData(0, [0x04, 0x01], name, [0x00, 0x00, 0x00])
  }

  async sendMessage (message, app = null, from = null) {
    // max length 128 characters; line wrap is hard after 8 characters (monospace)
    // 1 page: 32 characters
    // 2+ pages: 40 chars on first page, 48 characters on following pages, 40 chars on last page
    if (app && from) {
      await this.sendChunkedData(0, [0xfa, 0x01, 0x07], from, [0x00], message, [0x00], app, [0x00])
    } else if (app) {
      await this.sendChunkedData(0, [0x01, 0x01, 0x00], message, [0x00], app, [0x00])
    } else {
      await this.sendChunkedData(0, [0x05, 0x01, 0x00], message, [0x00, 0x00])
    }
  }

  async sendAlarm () {
    await this.sendChunkedData(0, [0xfa, 0x01, 0x0a, 0x00, 0x00, 0x00])
  }

  async sendPlace (place) {
    await this.sendChunkedData(1, [0x08], place, [0x00])
  }

  async sendTime (time) {
    time = time instanceof MiDate ? time : new MiDate(time, this.timeZone)
    await this.sendChunkedData(1, [0x04], time.toUInt32(true), [0xff, 0xff, 0x00])
  }

  async sendWeatherForecast (time, forecast) {
    time = time instanceof MiDate ? time : new MiDate(time, this.timeZone)
    await this.sendChunkedData(1, [0x01], time.toUInt32(true), [0x05 /* number of days? */], ...forecast.map(day => concat([day.icon, day.iconNight || day.icon, day.temperatureMin, day.temperatureMax], day.summary, [0x00])))
  }

  async sendWeatherCurrent (time, { icon, temperature, summary }) {
    time = time instanceof MiDate ? time : new MiDate(time, this.timeZone)
    await this.sendChunkedData(1, [0x02], time.toUInt32(true), [icon, temperature], summary, [0x00])
  }

  async sendSuntimes (time, suntimes) {
    time = time instanceof MiDate ? time : new MiDate(time, this.timeZone)
    suntimes = suntimes.map(time => time instanceof MiDate ? time : new MiDate(time, this.timeZone))
    await this.sendChunkedData(1, [0x10], time.toUInt32(true), suntimes[0].toBuffer('Hi'), suntimes[1].toBuffer('Hi'))
  }

  async sendWeather (data) {
    const time = new MiDate(data.time, data.timeZone || this.timeZone) // timezone from weather place?
    await this.sendPlace(data.place || this.place)
    await this.sendTime(time)
    await this.sendWeatherForecast(time, data.forecast)
    await this.sendWeatherCurrent(time, data)
    await this.sendSuntimes(time, data.sunTimes)
  }

  async sendWeatherAlert (message, heading = '') {
    await this.sendChunkedData(0, [0xfa, 0x01, 0x23], heading, [0x00], message, [0x00, 0x00])
  }

  async sendSilentMode (yesno) {
    await this.write('0003', [0x06, 0x19, 0x00, +!!yesno])
  }

  async onSilentModeToggle (callback) {
    const channel = band.char('0010')
    await channel.subscribeAsync()
    const onData = (data) => {
      if (data[0] !== 0x10) return
      const res = callback(!!data[1])
      if (res instanceof Promise) {
        res.then((r) => {
          if (r === false) {
            channel.removeListener('data', onData)
          }
          band.write('0003', [0x06, 0x19, 0x00, data[1]])
        })
        return
      }
      if (res === false) {
        channel.removeListener('data', onData)
      }
      band.write('0003', [0x06, 0x19, 0x00, data[1]])
    }
    channel.on('data', onData)
  }

  async getActivityRaw (next = null) {
    const collection = []
    let res
    if (!next) {
      next = new MiDate(Date.now() - 30 * 864e5)
    } else if (!(next instanceof MiDate)) {
      next = new MiDate(next)
    }
    // datetime = concat(date2Buffer(datetime, false), [0x00])
    const dataChannel = this.char('0005')
    await dataChannel.subscribeAsync()
    while (true) {
      res = await this.waitNotify('0004', 1000, [0x01, 0x01], next.toBuffer('YmdHi0e'))
      if (res.indexOf('\x10\x01\x01')) {
        console.error('error:', data)
        break
      }
      const start = new MiDate(res.slice(7))
      const minutes = res.readUInt16LE(3)
      if (!minutes) {
        if (start.equals(next)) break
        next = start
        continue
      }
      const buffer = Buffer.alloc(minutes * 4)
      let pos = 0
      const onData = (data) => {
        data.slice(1).copy(buffer, pos * 4)
        pos += Math.floor(data.length / 4)
      }
      dataChannel.on('data', onData)
      res = await this.waitNotify('0004', 0, [0x02])
      dataChannel.removeListener('data', onData)
      if (res.indexOf('\x10\x02\x01')) {
        console.error('error:', data)
        break
      }
      next = start.clone().addMinutes(minutes)
      collection.push({ date: start.getDate(), next: next.getDate(), minutes, buffer })
    }
    await this.write('0004', [0x03])
    return collection
  }

  async getActivity (date = null, fields = null) {
    if (!date) {
      date = new Date(Date.now() - 864e5) // 24 hours before now
    }
    const rawCollection = await this.getActivityRaw(date)
    const collection = rawCollection.map(data => parseActivity(data.buffer, data.date, fields))
    return [].concat(...collection)
  }

  async getLivePulse (callback, minutes = .5) {
    const dataChannel = this.char('2a37')
    await dataChannel.subscribeAsync()
    const onData = (data) => {
      if (data[0] !== 0x00) {
        return false
      }
      callback(data[1])
    }
    dataChannel.on('data', onData)
    await this.write('2a39', [0x15, 0x01, 0x01])
    for (let c = 0; c < minutes * 4; c++) {
      await this.write('2a39', [0x16])
      await delay(15e3)
    }
    await this.write('2a39', [0x15, 0x01, 0x00])
    await delay(500)
    dataChannel.removeListener('data', onData)
  }

  async getLiveAcceleration (callback, minutes = .5) {
    const dataChannel = this.char('0002')
    await dataChannel.subscribeAsync()
    const onData = (data) => {
      if (data[0] !== 0x01) {
        // console.log('[0002]', data)
        return
      }
      for (let i = 2; i < data.length; i += 6) {
        // const vector = [
          // data.readInt16LE(i),
          // data.readInt16LE(i + 2),
          // data.readInt16LE(i + 4)
        // ]
        // console.log(vector.map(v => (v >= 0 ? '+' : '') + (v / 256).toFixed(1)).join(' '))
        callback({
          x: data.readInt16LE(i) / 256,
          y: data.readInt16LE(i + 2) / 256,
          z: data.readInt16LE(i + 4) / 256
        })
      }
    }
    dataChannel.on('data', onData)
    for (let c = 0; c < minutes * 2; c++) {
      await this.write('0001', [0x01, 0x01, 0x19])
      await this.write('0001', [0x02])
      await delay(30e3)
    }
    await this.write('0001', [0x03])
    await delay(500)
    dataChannel.removeListener('data', onData)
  }

  async vibrate () {
    await this.write('alert_level', [0x03])
  }
}

module.exports = {
  MiBand, MiDate, UInt16, UInt32, concat, delay,
  OpenWeatherMap, TrackerDB
}
