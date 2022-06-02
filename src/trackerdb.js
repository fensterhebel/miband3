const fs = require('fs')
const { MiDate, parseActivity } = require('./helpers')

const date2file = date => date.toISOString().replace(/\D/g, '-').substr(0, 16)
const file2date = sort => Date.UTC(.../(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)/.exec(sort).slice(1).map((n, i) => +n - (i === 1)))

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
        minutes: last.minutes + data[i].minutes,
        next: data[i].next
      })
      data.splice(i, 1)
      i--
    }
    return data
  }

  constructor (dir = 'data', suffix = '.bin', maxFileMinutes = 2 ** 15) {
    this.dir = dir.replace(/[\/\\]*$/, '/')
    this.suffix = suffix
    this.maxFileMinutes = maxFileMinutes
  }

  saveData (data) {
    if (Array.isArray(data)) {
      for (const part of data) {
        this.saveData(part)
      }
      return
    }
    const chunks = this.getChunks()
    const best = chunks.find(chunk => chunk.next.getTime() >= data.date.getTime())
    if (best) {
      const overlap = (best.next.getTime() - data.date.getTime()) / 6e4
      if (best.minutes + data.minutes - overlap <= this.maxFileMinutes) {
        fs.appendFileSync(best.path, data.buffer.slice(overlap * 4))
        return
      }
    }
    const date = date2file(data.date)
    const file = this.dir + date + this.suffix
    fs.writeFileSync(file, data.buffer)
  }

  getChunks () {
    const files = fs.readdirSync(this.dir).filter(file => file.endsWith(this.suffix)).sort()
    return files.map((file) => {
      const timestamp = file2date(file)
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
        const pos = Math.floor((date - file.date) / 6e4)
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
