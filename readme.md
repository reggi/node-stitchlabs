# StitchLabs API Wrapper

Created specifically for [node-inventory-bridge](https://github.com/reggi/node-inventory-bridge)

Apologies for poor documentation!

Wraps around request-promises to provide an easy way to interact with the [StitchLabs api](https://developer.stitchlabs.com).

## Usage

The lib assumes you already have the access token for an account.

```
var Stitch = require("stitchlabs")
var stitch = new Stitch({
  accessToken: process.env.STITCH_ACCESS_TOKEN,
})

// Gets Products
stitch.request("api2/v2/Products")
  .then(console.log)
  .catch(function(e){
    console.log(e.error.message)
  })

// Creates a ReconcileReasonType
stitch.request({
    "url": "api2/v1/ReconcileReasonTypes/detail",
    "body": {
      "action": "write",
      "ReconcileReasonTypes": [
        {
          "name": "Custom ReconcileReasonType"
        }
      ]
    }
  })
  .then(console.log)
  .catch(function(e){
    console.log(e.error.message)
  })
```
