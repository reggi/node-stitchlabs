var debug = require("debug")("StitchLabs")
var moment = require("moment")
var path = require("path")
var dotty = require("dotty")
var url = require("url")
var Promise = require("bluebird")
var fs = Promise.promisifyAll(require("fs"))
var rp = require('request-promise')
var _ = require("underscore")
var crypto = require('crypto')
var lodash = require("lodash")

var underscoreDeepExtend = require("underscore-deep-extend")
_.mixin({deepExtend: underscoreDeepExtend(_)});

// defines the object and properties
function StitchLabs(data){
  if(!data.accessToken) return new Error("missing accessToken")
  this.accessToken = data.accessToken
  this.cacheDir = (data.cacheDir) ? data.cacheDir : false
  this.cacheAlive = (data.cacheAlive) ? data.cacheAlive : false
  this.cacheOverrde = (data.cacheOverrde && data.cacheDir) ? true : false
  this.requestsPerSecond = (data.requestsPerSecond) ? data.requestsPerSecond : 1
  this.makeRequest = this.promiseDebounce(this.req, 4000, this.requestsPerSecond)
  this.pageSize = (data.pageSize) ? data.pageSize : 5
  this.consumerUrl = (data.consumerUrl) ? data.consumerUrl : false
  return this
}

// debounce requests per second
StitchLabs.prototype.promiseDebounce = function(fn, delay, count) {
  var working = 0, queue = [];
  function work() {
    if ((queue.length === 0) || (working === count)) return;
    working++;
    Promise.delay(delay).tap(function () { working--; }).then(work);
    var next = queue.shift();
    next[2](fn.apply(next[0], next[1]));
  }
  return function debounced() {
    var args = arguments;
    return new Promise(function(resolve){
      queue.push([this, args, resolve]);
      if (working < count) work();
    }.bind(this));
  }
}

// sets up defaults for request options
StitchLabs.prototype.parseRequestOptions = function(requestOptions){
  if(typeof requestOptions == "string"){
    var stringUrl = requestOptions
    requestOptions = {}
    requestOptions.url = stringUrl
  }
  var fetchUrl = requestOptions.url || requestOptions.uri
  delete requestOptions.url
  delete requestOptions.uri
  var parsedUrl = url.parse(fetchUrl)
  parsedUrl.protocol = "https:"
  parsedUrl.host = "api-pub.stitchlabs.com"
  parsedUrl.hostname = parsedUrl.host
  requestOptions.url = url.format(parsedUrl)
  var defaultOptions = {
    "headers": {
      "access_token": this.accessToken,
      "Content-Type": "application/json;charset=UTF-8",
    },
    "return_options": true,
    "method" : "POST",
    "json": true,
    "body": {
      "action": "read",
    }
  }

  if(dotty.exists(requestOptions, "body.action") && requestOptions.body.action !== "write" || !dotty.exists(requestOptions, "body.action")){
    defaultOptions.body["page_num"] = 1
    defaultOptions.body["page_size"] = this.pageSize
  }

  var options = _.deepExtend(defaultOptions, requestOptions)

  return options
}

// makes a http request to stitch using parsed request options
StitchLabs.prototype.req = function(requestOptions){
  requestOptions = this.parseRequestOptions(requestOptions)
  var hash = this.getRequestObjectHash(requestOptions)
  debug("making request %s on page %d (%s)", requestOptions.url, requestOptions.body.page_num, hash)
  return Promise.resolve().then(function(){
    return rp(requestOptions).then(function(response){
      if(requestOptions.return_options) response.options = requestOptions
      return response
    })
  })
}

// gets a hash of the JSON request object for content addressing requests
StitchLabs.prototype.getRequestObjectHash = function(requestOptions){
  var cloneRequestOptions = _.clone(requestOptions)
  delete cloneRequestOptions.return_options
  return crypto
    .createHash("md5")
    .update(JSON.stringify(cloneRequestOptions))
    .digest("hex")
}

// opens cache directory and looks for latest hash file
StitchLabs.prototype.getLastestFileWithPrefix = function(hashPrefix){
  if(!this.cacheDir) throw new Error("no cache directory")
  return fs.readdirAsync(this.cacheDir)
    .then(function(dirFiles){
      // process the files in the dir
      var latestFile = _.chain(dirFiles)
        .map(function(dirFile){
          // parse the dirFile
          dirFile = path.parse(path.join(this.cacheDir, dirFile))
          dirFile.hashPrefix = dirFile.name.split("-")[0]
          dirFile.timestamp = dirFile.name.split("-")[1]
          return dirFile
        }.bind(this))
        .filter(function(dirFile){
          // filter dir files where string without timestamp don't match
          return dirFile.hashPrefix == hashPrefix
        })
        .sortBy("timestamp")
        .last()
        .value()

      var now = moment()
      var timestamp = now.format("X")
      var assemble = [hashPrefix, timestamp].join("-") + ".json"
      var newCacheFile = path.parse(path.join(this.cacheDir, assemble))
      newCacheFile.exist = false
      newCacheFile.timeout = false
      newCacheFile.moment = now
      newCacheFile.timestamp = timestamp
      newCacheFile.hashPrefix = hashPrefix
      newCacheFile.format = path.format(newCacheFile)

      if(latestFile){
        latestFile.exist = true
        latestFile.moment = moment(latestFile.timestamp, "X")
        var hourAgo = moment().subtract(this.cacheAlive, "seconds")
        latestFile.timeout = latestFile.moment.isBefore(hourAgo)
        latestFile.format = path.format(latestFile)
        if(latestFile.timeout) return newCacheFile
        return latestFile
      }else{
        return newCacheFile
      }
  }.bind(this))
}

// creates a cache request fetches existing or requests and stores response
StitchLabs.prototype.cacheRequest = function(requestOptions){
  requestOptions = this.parseRequestOptions(requestOptions)
  var hash = this.getRequestObjectHash(requestOptions)

  return this.getLastestFileWithPrefix(hash)
    .then(function(latestFile){
      if(latestFile.exist && !latestFile.timeout){
        return fs.readFileAsync(latestFile.format, "utf8").then(function(content){
          content = JSON.parse(content)
          debug("cache file successfully read %s on page %s", latestFile.base, content.options.body.page_num)
          return content
        })
      }else{
        return this.makeRequest(requestOptions)
          .then(function(content){
            var stringifiedContent = JSON.stringify(content, null, 2)
            fs.writeFileAsync(latestFile.format, stringifiedContent).then(function(data){
              debug("cache file successfully written %s", latestFile.base)
            })
            return content
          })
      }
    }.bind(this))
}

// a handler for overriding all requests with cached requests
StitchLabs.prototype.request = function(requestOptions){
  if(this.cacheOverrde) return this.cacheRequest(requestOptions)
  return this.makeRequest(requestOptions)
}

// parses through paginated responses and returns major objects
StitchLabs.prototype.mergeResponses = function(responses){
  //console.log(responses)
  var build = []
  _.each(responses, function(response){
    delete response.meta
    delete response.options
    _.each(response, function(value, key){
      if(typeof build[key] == "undefined") build[key] = []
      build[key].push(_.values(value))
    })
  })
  build = _.mapObject(build, function(value, key){
    return _.flatten(value)
  })
  return build
}

// paginates a given request / response
StitchLabs.prototype.paginate = function(response){
  var numberOfPages = parseInt(response.meta.last_page, 10)
  if(numberOfPages == 1) return [response]
  var startPoint = response.options.body.page_num + 1
  return Promise.map(_.range(startPoint, numberOfPages+1), function(page){
    var options = lodash.cloneDeep(response.options)
    options.body.page_num = page
    return this.request(options)
  }.bind(this)).then(function(responses){
    responses.unshift(response)
    return responses
  })
}

// handler for requesting all
StitchLabs.prototype.requestAll = function(requestOptions){
  return this.request(requestOptions)
    .bind(this)
    .then(this.paginate)
    .then(this.mergeResponses)
}

//fetch desired object within response
StitchLabs.prototype.propigateResponse = function(requests){
  var propigated = _.mapObject(requests, function(request, key){
    return request[key]
  })
  propigated.requests = requests
  return propigated
}

StitchLabs.prototype.getVariantUrl = function(stitchVariant){
  if(!this.consumerUrl) return false
  if(!dotty.exists(stitchVariant, "links.Products.0.id")) return false
  if(!dotty.exists(stitchVariant, "id")) return false
  return "https://"+this.consumerUrl+".stitchlabs.com/inventory/"+stitchVariant.links.Products[0].id+"/variants/"+stitchVariant.id
}

module.exports = StitchLabs
