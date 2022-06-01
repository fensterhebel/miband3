const https = require('https')
const GET = url => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    res.setEncoding('utf8')
    let data = ''
    res.on('data', (chunk) => {
      data += chunk
    })
    res.on('end', () => resolve(data))
  }).on('error', (e) => reject(e))
})

function miIcon (condition) {
  // https://openweathermap.org/weather-conditions
  return [0, 1, 2, 2, 17, 3, 3, 3, 7, 7, 4, 3, 14][+condition.icon.substr(0, 2) % 45 - 1]
}

function shortText (moment, lang = 'en') {
  let str = moment.weather[0].description
  str = str.replace(/\.$/, '')
  if (lang === 'en') {
    str = str.replace(/ with /g, ' & ')
    str = str.replace(/light /g, 'l. ')
    str = str.replace(/heavy /g, 'h. ')
    str = str.replace(/intensity /g, 'int. ')
    str = str.replace(/thunderstorm /g, 'thund. ')
    str = str.split(':')[0]
  } else if (lang === 'de') {
    str = str.replace(/leicht[ers]* /gi, 'l. ')
    str = str.replace(/schwer[ers]* /gi, 's. ')
    str = str.replace(/mäßig[ers]* /gi, 'm. ')
    str = str.replace(/ein paar /gi, 'etw. ')
    str = str.replace(/überwiegend /gi, '')
    str = str.replace(/klar[er]* /gi, 'kl. ')
    str = str.replace(/ (mit|und) /gi, ' u. ')
  }
  if (moment.rain) {
    str += ' ' + (moment.rain < 1 ? '<1' : moment.rain.toFixed(1)) + 'mm'
  }
  return str
}

class OpenWeatherMap {
  constructor (options) {
    // defaults
    this.apiKey = null
    this.lang = 'en'
    this.units = 'metric' // because Kelvin is not sensible, neither is Fahrenheit :)

    // options: apiKey, lang, units
    Object.assign(this, options)
  }

  request (endpoint, params = {}) {
    Object.assign(params, {
      appid: this.apiKey,
      lang: this.lang,
      units: this.units
    })
    const baseUrl ='https://api.openweathermap.org/data/2.5/' + endpoint
    return GET(baseUrl + '?' + Object.keys(params).map(key => key + '=' + encodeURIComponent(params[key])).join('&')).then(raw => JSON.parse(raw))
  }

  async getWeather ({ lon, lat }) {
    const { current, daily } = await this.request('onecall', {
      lat, lon, exclude: 'minutely,hourly'
    })
    return {
      lat, lon, lang: this.lang, units: this.units,
      time: new Date(current.dt * 1000),
      sunTimes: [new Date(current.sunrise * 1000), new Date(current.sunset * 1000)],
      temperature: Math.round(current.temp),
      icon: miIcon(current.weather[0]),
      summary: shortText(current, this.lang),
      forecast: daily.slice(0, 5).map((day) => ({
        icon: miIcon(day.weather[0]),
        summary: shortText(day, this.lang),
        temperatureMin: Math.round(day.temp.min),
        temperatureMax: Math.round(day.temp.max)
      }))
    }
  }
}

module.exports = OpenWeatherMap
