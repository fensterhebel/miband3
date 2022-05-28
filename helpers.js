const UInt16 = (number) => {
  const buf = Buffer.alloc(2)
  buf.writeUInt16LE(number)
  return buf
}
const UInt32 = (number) => {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(number)
  return buf
}

class MiDate {
  constructor (date = null, timeZone = null) {
    this.setTimezone(timeZone)
    const now = new Date()
    if (!date) {
      this.date = now.getTime() // already UTC
    } else if (date instanceof Date) {
      this.date = date.getTime() // - this.minuteOffset * 6e4
    } else if (typeof date === 'number') {
      this.date = date
    } else if (date instanceof this.constructor) {
      if (timeZone === null) {
        this.minuteOffset = date.minuteOffset
      }
      this.date = date.date
    } else if (date instanceof Buffer) {
      if (date.length === 11 && !date[8] && !date[9]) {
        this.minuteOffset = date.readInt8(10) * 15
      } else if (date.length === 8) {
        this.minuteOffset = date.readInt8(7) * 15
      }
      // can be 0x80 = -128 which means ? maybe "not set", so we assume UTC
      if (Math.abs(this.minuteOffset) >= 24 * 15) {
        this.minuteOffset = 0
      }
      this.date = Date.UTC(date.readUInt16LE(), date[2] - 1, date[3], date[4] || 0, date[5] || 0, date[6] || 0) - this.minuteOffset * 6e4
    } else if (/^\d\d?:\d\d$/.test(date)) {
      now.setUTCHours(+date.split(':')[0])
      now.setUTCMinutes(+date.split(':')[1]) // - this.minuteOffset
      now.setSeconds(0)
      now.setMilliseconds(0)
      this.date = now.getTime()
    } else if (typeof date === 'string') {
      if (timeZone = /([+-]\d\d):?(\d\d)?$/.exec(date)) {
        this.minuteOffset = +timeZone[1] * 60 + (+timeZone[2] || 0)
      }
      this.date = Date.UTC(...date.toString().split(/\D+/).map((n, i) => +n - (i === 1))) - this.minuteOffset * 6e4
    } else {
      throw new Error('unknown date format')
    }
  }

  setTimezone (timeZone = null) {
    const now = new Date()
    if (typeof timeZone === 'number') {
      this.minuteOffset = timeZone
    } else if (/^[+-]?(\d\d?)(:\d\d)?$/.test(timeZone)) {
      this.minuteOffset = timeZone.split(':').reduce((a, c) => a * 60 + (Math.sign(a) < 0 ? -c : +c), 0)
    } else if (timeZone === 'local') {
      this.minuteOffset = -now.getTimezoneOffset()
    } else if (typeof timeZone === 'string') {
      this.minuteOffset = Math.round((Date.UTC(...now.toLocaleString('ja-JP', { timeZone }).split(/\D+/).map((n, i) => +n - (i === 1))) - now.getTime()) / 6e4)
    } else if (!timeZone) {
      this.minuteOffset = 0 // UTC
    } else {
      throw new Error('unknown timezone format')
    }
  }

  addMinutes (minutes) {
    this.date += minutes * 6e4
    return this
  }

  toBuffer (format, UTC = false) {
    const date = new Date(this.date + !UTC * this.minuteOffset * 6e4)
    const arr = []
    format.split('').forEach((d) => {
      switch (d) {
        case 'Y': return arr.push(date.getUTCFullYear() % 0x100, date.getUTCFullYear() / 0x100)
        case 'm': return arr.push(date.getUTCMonth() + 1)
        case 'd': return arr.push(date.getUTCDate())
        case 'H': return arr.push(date.getUTCHours())
        case 'i': return arr.push(date.getUTCMinutes())
        case 's': return arr.push(date.getUTCSeconds())
        case 'w': return arr.push(date.getUTCDay())
        case 'e': case 'p': case 'P': return arr.push(this.minuteOffset / 15)
        case '0': return arr.push(0)
        // default: return arr.push(d.charCodeAt(0))
      }
    })
    if (DEBUG) console.log('date:', arr)
    return Buffer.from(arr)
  }

  toUInt32 (addTimezone = false) {
    const buf = Buffer.alloc(4 +!!addTimezone)
    buf.writeUInt32LE(this.date / 1000)
    if (addTimezone) {
      buf[4] = this.minuteOffset / 15
    }
    return buf
  }

  getDayOfWeek () {
    return new Date(this.date + this.minuteOffset * 6e4).getUTCDay()
  }

  getDate () {
    return new Date(this.date)
  }

  static dateFrom (date = null, timeZone = null) {
    return new this.constructor(date, timeZone).getDate()
  }

  clone () {
    return new this.constructor(this)
  }

  equals (midate, ignoreTimezone = false) {
    return midate.date === this.date && (ignoreTimezone || (midate.minuteOffset === this.minuteOffset))
  }

  toString () {
    const date = new Date(this.date + this.minuteOffset * 6e4).toISOString().substr(0, 23)
    if (!this.minuteOffset) {
      return date + 'Z'
    }
    const offset = Math.abs(this.minuteOffset)
    return date + (Math.sign(this.minuteOffset) < 0 ? '-' : '+') + [Math.floor(offset / 60), offset % 60].map(d => d.toString().padStart(2, '0')).join(':')
  }
}

function parseActivity (raw, date = null, fields = null) {
  if (date) {
    date = date instanceof MiDate ? date : new MiDate(date, 'local')
  }
  const pretty = []
  for (let i = 0; i < raw.length; i += 4) {
    if (!raw[i]) {
      pretty.push(null)
    } else {
      const minute = {}
      if (date) {
        if (!fields || fields.includes('time')) {
          minute.time = date.toString().substr(11, 5)
        }
        if (fields && fields.includes('date')) {
          minute.time = date.toString().substr(11, 5)
        }
      }
      if (!fields || fields.includes('action')) {
        minute.action = '?' // raw[i].toString(2).padStart(8, '0')
        if ((raw[i] & 0x70) === 0x70) {
          minute.action = 'sleep'
        } else if ((raw[i] & 0x50) === 0x50) {
          minute.action = 'rest'
        } else if ((raw[i] & 0x01) === 0x01) {
          minute.action = 'walk'
        }
      }
      if (fields && fields.includes('code')) {
        minute.code = raw[i].toString(2).padStart(8, '0')
      }
      if (!fields || fields.includes('shake')) {
        minute.shake = raw[i + 1]
      }
      if (!fields || fields.includes('steps')) {
        minute.steps = raw[i + 2]
      }
      if (raw[i + 3] < 0xff || fields && fields.includes('heart')) {
        minute.heart = raw[i + 3] === 0xff ? false : raw[i + 3]
      }
      pretty.push(minute)
    }
    if (date) date.addMinutes(1)
  }
  return pretty
}

module.exports = { MiDate, UInt16, UInt32, parseActivity }
