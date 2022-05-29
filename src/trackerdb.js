const fs = require('fs')
const { MiDate, parseActivity } = require('./helpers')

class ActivityTrackerDB {
  static reduceDataArray (data) {
    let last = null
    for (let i = 0; i < data.length; i++) {
      if (!last || last.next < data[i].date) {
        last = data[i]
        continue
      }
      Object.assign(last, {
        buffer: Buffer.concat([last.buffer, data[i].buffer]),
        count: last.count + data[i].count,
        next: data[i].next
      })
      data.splice(i, 1)
      i--
    }
    return data
  }

  constructor (dir = 'data', suffix = '.bin') {
    this.dir = dir.replace(/[\/\\]*$/, '/')
    this.suffix = suffix
  }

  saveData (data) {
    if (Array.isArray(data)) {
      for (const part of data) {
        this.saveData(part)
      }
      return
    }
    const date = data.date.toISOString().replace(/\D/g, '-').substr(0, 16)
    const file = this.dir + date + this.suffix
    fs.writeFileSync(file, data.buffer)
  }

  getChunks () {
    const files = fs.readdirSync(this.dir).filter(file => file.endsWith(this.suffix)).sort()
    return files.map((file) => {
      const timestamp = Date.UTC(.../(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)/.exec(file).slice(1).map((n, i) => +n - (i === 1)))
      const minutes = fs.statSync(this.dir + file).size / 4
      return {
        path: this.dir + file,
        name: file,
        date: new Date(timestamp),
        minutes,
        next: new Date(timestamp + minutes * 6e4)
      }
    })
  }

  getDataRaw (date, minutes = 0) {
    const end = new Date(date.getTime() + minutes * 6e4)
    const files = this.getChunks()
    const data = Buffer.alloc(minutes * 4)
    for (const file of files) {
      if (file.date < end && file.next > date) {
        const pos = (date - file.date) / 6e4
        const source = fs.readFileSync(file.path)
        source.copy(data, Math.max(-pos, 0) * 4, Math.max(pos, 0) * 4, Math.min(minutes + pos, source.length / 4) * 4)
      }
    }
    return data
  }

  getData (date, minutes = 1440, skipempty = false) {
    const raw = this.getDataRaw(date, minutes)
    return parseActivity(raw, date).filter(m => !skipempty || !!m)
  }

  getNextDate () {
    const lastFile = this.getChunks().pop()
    if (!lastFile) return null
    return lastFile.next
  }
}

module.exports = ActivityTrackerDB
