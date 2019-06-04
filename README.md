## FrodoBot

Version 0.0.4

Uses Puppeteer and Axios to complete autocheckout against Hibbett Sports' mobile api.


### Installation / Start Up

`git clone`

`cd frodobot`

`npm install`

`npm start`

### Known Issues

* This solution is very memory heavy
* Each thread that you spawn will run a chrome instance momentarily to combat PX blocking. Dont blow up your machine.
* There is very little validation/error handling here. 4XX errors will crash a thread, 5XX errors will get repeated mercilessly



### Task Setup

Notes:

* Ensure that state's are abbreviated and capitalized
* Follow the format in  `profiles.example.js` as close as possible
* If a field is blank (i.e. apartment), leave it as `''`.
* Guest logins aren't currently supported (experimental)
* Phone numbers should be a string of numbers, no dashes or spaces
* Ensure that credit card expiration has no preceeding zeros (e.g. 5 instead of 05)
* Make changes to the example file and then rename it as `profiles.js`
* User/pass authenticated proxies are **not** supported, only IP authentication for now.
* Shipping address == billing address.
* Cards supported: `Visa` and `Master Card`. Amex coming later.
* PerimeterX tokens last 10 minutes. I wouldnt start the bot more than 10 minutes out as if the token expires, it will take some time to replace.
* Note that Prolific cart tokens (nonce) **last 5 minutes**. If using a release mode (2) pre fetches a cart nonce, dont start more than 5 minutes before release.
* Drop times are 24 hour, in the local timezone that the script is being ran.


### Modes

1) **Mode 1**: Guest mode. This is the most vanilla usage of the bot. Adds to cart like a normal person would, start to finish.
2) **Mode 2**: Login release mode. This is the most powerful option. Requires the shoes to be added to the cart via desktop and then login to account on the bot.
3) **Mode 3**: Restock mode. Similar to guest mode. This is in development.


### TODO List

* Configuration validation/checking
* ~~Move some settings to global config file (headers, tls setting)~~
* /lib /docs folder structure
* Automatic token timers for cart nonce, px tokens, login jwt
* Move px token generation into an external thread that only uses 1 pptr instance
* Actually throw errors like a man
* HTTP/2 support for Axios
* Amex/Discover support (need to test cards, amex has diff length)
* ~~Add thread uuid to logging~~

### License

Software is provided with no support or guarantee of support. 
Please be careful when using autocheckout bots, they can be prone to errors which can
erroneously checkout incorrect products.

Software is released under MIT license.