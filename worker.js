

const puppeteer = require('puppeteer');

const iPhone = puppeteer.devices['iPhone X'];
const { TimeoutError } = require('puppeteer/Errors');
const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');
const chalk = require('chalk');
const uuidv4 = require('uuid/v4');
const settings = require('./settings.js');

require('console-stamp')(console, {
  pattern: 'HH:MM:ss.l',
  colors: {
    stamp: chalk.cyan,
  },
});

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// TODO: write env check to turn on and off tls reject
//  - better error handling function for requests (403, 429, 5XX)
//  - import constants from external file

class Worker {
  constructor(profile) {
    this.uuid = uuidv4();

    function addUuidToConsole(uuid) {
      if (console.log) {
        const old = console.log;
        console.log = function log(...args) {
          Array.prototype.unshift.call(args, `[${uuid}] `);
          old.apply(this, args);
        };
      }
      if (console.warn) {
        const old = console.warn;
        console.warn = function warn(...args) {
          Array.prototype.unshift.call(args, `[${chalk.red(uuid)}] `);
          old.apply(this, args);
        };
      }
      if (console.error) {
        const old = console.error;
        console.error = function error(...args) {
          Array.prototype.unshift.call(args, `[${chalk.red(uuid)}] `);
          old.apply(this, args);
        };
      }
    }
    (addUuidToConsole(this.uuid));

    this.profile = profile;

    const axiosOptions = {
      baseURL: settings.app_base_url,
      headers: {
        'user-agent': settings.mobile_user_agent,
        'accept-language': 'en-US;q=1.0',
        'accept-encoding': 'gzip;q=1.0, compress;q=0.5',
        'content-type': 'application/json; charset=utf-8',
        accept: '*/*',
        version: settings.app_version,
        platform: settings.app_platform,
        'x-api-key': settings.api_key,
      },
      withCredentials: true,

    };

    if (this.profile.proxy !== '' && this.profile.proxy) {
      axiosOptions.httpsAgent = new HttpsProxyAgent(`http://${this.profile.proxy}`);
    }

    this.prolific_transport = axios.create(axiosOptions);
    // Custom error handling for 403 blocking and 5xx server downtime
    this.prolific_transport.interceptors.response.use(null, async (error) => {
      if (error.config && error.response && error.response.status === 403) {
        console.error('PX: Block, updating token');
        await this.getNewPxToken();
        return this.prolific_transport.request({
          method: error.config.method,
          url: error.config.url,
          params: error.config.params,
          data: error.config.data,
          withCredentials: true,
        });
      }
      // Server errors 5xx retry
      if (error.config && error.response && error.response.status >= 500) {
        console.error('5XX server error, repeating request');
        return this.prolific_transport.request({
          method: error.config.method,
          url: error.config.url,
          params: error.config.params,
          withCredentials: true,
        });
      }
      return Promise.reject(error);
    });

    this.mode = this.profile.mode;
    this.drop_time = this.profile.drop_time;

    this.customer_id = null;
    this.session_id = null;
    this.basket_id = null;
    this.product_id = null;
    this.basket_nonce = null;
    this.basket_total = null;

    this.master_pid = this.profile.master_pid;
    this.target_size = this.profile.target_size;

    this.email = this.profile.email;
    this.password = this.profile.password;

    this.first_name = this.profile.first_name;
    this.last_name = this.profile.last_name;
    this.city = this.profile.city;
    this.zip = this.profile.zip;
    this.phone = this.profile.phone;
    this.address1 = this.profile.address1;
    this.address2 = this.profile.address2;
    this.state = this.profile.state;

    this.cc_num = this.profile.cc_num;
    this.cc_exp_y = this.profile.cc_exp_y;
    this.cc_exp_m = this.profile.cc_exp_m;
    this.cvv = this.profile.cc_cvv;
    this.cc_type = this.profile.cc_type;

    this.cc_token = null;
    this.encrypted_cc = null;
    this.encrypted_cvv = null;

    this.cookies = [];
    this.pids = [];
    this.sel_pid = null;
  }

  /*
    getNewPxToken() - uses puppeteer to grab cookies via a headless browser
     */
  async getNewPxToken() {
    // TODO: set a 10minute timer here to renew the auth key every now and then
    //  - potentially change the endpoint?
    //  - potentially change the timeout here
    //  - add mouse movement/activity
    //  - add page scroll movement/activity
    try {
      console.log('PX: Starting');

      const pptrConfig = {
        headless: true,
        ignoreHTTPSErrors: true,
      };

      if (this.profile.proxy && this.profile.proxy !== '') {
        pptrConfig.args = [`--proxy-server=${this.profile.proxy}`];
      }

      const browser = await puppeteer.launch(pptrConfig);
      const context = await browser.createIncognitoBrowserContext();
      const page = await context.newPage();
      await page.emulate(iPhone);
      await page.setJavaScriptEnabled(true);

      // load the page
      await page.goto('https://hibbett-mobileapi.prolific.io/ecommerce/shopview')
        .then(async (response) => {
          console.log(`PX: Initial response code: ${await response.headers().status}`);
        })
        .catch(async (e) => {
          if (e instanceof TimeoutError) {
            console.warn('PX: timeout, restarting');
            browser.close();
            await this.getNewPxToken();
          }
        });

      // we probably get a 403 block by px so wait 10 sec and reload
      await page.waitFor(10000);

      await page.reload().then(async (response) => {
        const responseCode = await response.headers().status;
        if (responseCode === '200') {
          console.log(chalk.green('PX: Final response code: 200'));
          try {
            this.cookies = await page.cookies();
            this.prolific_transport.defaults.headers['x-px-authorization'] = `3:${this.cookies.filter(cookie => cookie.name === '_px3')[0].value}`;
            await browser.close();
          } catch (e) {
            console.error(e);
          }
        } else {
          console.error(`PX: Failed to get a good 200 status code after 10sec reload: ${responseCode}`);
          if (responseCode === 403) {
            console.log('PX: Retrying with "longer" delay');
            // TODO: increase delay here
            await browser.close();
            await this.getNewPxToken();
          }
        }
      });
    } catch (e) {
      console.error(e);
    }
  }

  async guestLogin() {
    console.log('Getting guest authorization');
    await this.prolific_transport.request({
      method: 'post',
      url: '/users/guest',
    })
      .then((res) => {
        console.log('Setting guest authorization header');
        this.session_id = res.data.sessionId;
        this.prolific_transport.defaults.headers.authorization = `Bearer ${res.data.sessionId}`;
        return Promise.resolve(this.session_id);
      })
      .catch((e) => {
        console.error(e);
        return Promise.reject(e);
      });
  }

  async login() {
    console.log(`Logging into account ${chalk.cyan(this.email)}`);
    await this.prolific_transport.request({
      method: 'post',
      url: '/users/login',
      data: {
        password: this.password,
        login: this.email,
      },
    })
      .then((res) => {
        console.log('Setting user authorization header');
        this.session_id = res.data.sessionId;
        this.prolific_transport.defaults.headers.authorization = `Bearer ${res.data.sessionId}`;
        console.log(`Setting customer id ${res.data.customerId}`);
        this.customer_id = res.data.customerId;
        return Promise.resolve();
      })
      .catch((e) => {
        if (e.response && e.response.status === 401) {
          console.error('Bad login');
          return Promise.reject();
        }
        console.error(e);
        return Promise.reject();
      });
  }

  /*
    logout() - method to log out of a logged in account. note that this will invalidate the session
    so further requests will need to be authenticated by login() or guestLogin()
     */
  async logout() {
    try {
      console.log('Logging out');
      const response = await this.prolific_transport.request({
        method: 'delete',
        url: '/users/logout',
      });
      if (response.data.success === true) {
        console.log('Successfully logged out');
        return Promise.resolve();
      }
      console.log('Logout response unsuccessful');
      return Promise.reject();
    } catch (e) {
      console.error(e);
      return Promise.reject(e);
    }
  }

  async getPids() {
    console.log(`getting pids for ${this.master_pid}`);
    await this.prolific_transport.request({
      method: 'get',
      url: `/ecommerce/products/${this.master_pid}`,
    })
      .then((res) => {
        this.pids = res.data.skus;
        return Promise.resolve(this.pids);
      })
      .catch((e) => {
        console.error(e);
        return Promise.reject(e);
      });
  }

  async selectPid() {
    console.log(`Selecting sku based on target size ${this.target_size}`);
    if (!this.pids) {
      console.error('Cant select a size from empty list of pids');
      return Promise.reject();
    }
    try {
      const selected = this.pids.filter(pid => pid.size === this.target_size)[0];
      this.sel_pid = selected.id;
      console.log(`Selected ${selected.id} for size ${this.target_size}`);
      return Promise.resolve(selected);
    } catch (e) {
      console.error(e);
      return Promise.reject();
    }
  }

  async getBasketIdForUser() {
    if (!this.customer_id) {
      console.error('Cant find a basket id without customer id');
      return Promise.reject();
    }
    console.log('Finding existing basket for user');
    await this.prolific_transport.request({
      method: 'get',
      url: `users/${this.customer_id}/basketId`,
    })
      .then((res) => {
        console.log(`Found existing basket id ${res.data.basketId}`);
        this.basket_id = res.data.basketId;
        return Promise.resolve(this.basket_id);
      })
      .catch((e) => {
        console.error(e);
        return Promise.reject(e);
      });
    return Promise.reject();
  }

  async createNewBasket() {
    console.log('Creating a new basket');
    await this.prolific_transport.request({
      method: 'post',
      url: '/ecommerce/cart/create',
    })
      .then((res) => {
        this.basket_id = res.data.basketId;
        console.log(`Got a new basket id ${this.basket_id}`);
        return Promise.resolve(this.basket_id);
      })
      .catch((e) => {
        console.log(e);
        return Promise.reject(e);
      });
    return Promise.reject();
  }

  async addToCart() {
    if (!this.sel_pid || !this.basket_id) {
      console.error('Cant atc, missing pid or basket id');
      return Promise.reject();
    }
    console.log('Adding to cart');
    await this.prolific_transport.request({
      method: 'post',
      url: `/ecommerce/cart/${this.basket_id}/items`,
      data: {
        cartItems: [{
          quantity: 1,
          sku: {
            id: this.sel_pid,
          },
          personalization: [],
          product: {
            id: this.sel_pid,
          },
          customerId: this.customer_id ? this.customer_id : '',
        }],
      },
    })
      .then((res) => {
        console.log(`Added ${this.sel_pid} to cart`);
        this.product_id = res.data.cartItems[0].id;
        return Promise.resolve(this.product_id);
      })
      .catch((e) => {
        console.error(e);
        return Promise.reject(e);
      });
    return Promise.reject();
  }

  async getCartNonce() {
    if (!this.basket_id) {
      console.error('Cant get cart nonce for null basket id');
      return Promise.reject();
    }
    console.log('Getting cart nonce');
    await this.prolific_transport.request({
      method: 'get',
      url: `/ecommerce/cart/${this.basket_id}/viewBag`,
      params: {
        customerId: this.customer_id ? this.customer_id : '',
      },
    })
      .then((res) => {
        console.log('Got cart nonce');
        this.basket_nonce = res.data.nonce;
        return Promise.resolve(this.basket_nonce);
      })
      .catch((e) => {
        console.error(e);
        return Promise.reject(e);
      });
    return Promise.reject();
  }

  async addEmail() {
    console.log('Adding email');
    await this.prolific_transport.request({
      method: 'put',
      url: `/ecommerce/cart/${this.basket_id}/customer`,
      data: {
        email: this.email,
      },
    })
      .then(() => {
        console.log('Successfully added email');
        return Promise.resolve();
      })
      .catch((e) => {
        console.error(e);
        Promise.reject(e);
      });
  }

  async addShippingAddress() {
    console.log('Adding shipping address');
    await this.prolific_transport.request({
      method: 'put',
      url: `/ecommerce/cart/${this.basket_id}/shipments/me/shipping_address`,
      params: {
        useAsBilling: true,
      },
      data: {
        state: this.state,
        city: this.city,
        address1: this.address1,
        address2: this.address2,
        zip: this.zip,
        save: false,
        lastName: this.last_name,
        phone: this.phone,
        firstName: this.first_name,
        country: 'US',
      },
    })
      .then(() => {
        console.log('Successfully added shipping address');
        return Promise.resolve();
      })
      .catch((e) => {
        console.error(e);
        return Promise.reject(e);
      });
  }

  async addShippingMethod() {
    console.log('Adding shipping method');
    await this.prolific_transport.request({
      method: 'put',
      url: `/ecommerce/cart/${this.basket_id}/shipments/me/shipping_options`,
      data: {
        id: 'ANY_GND',
      },
    })
      .then((res) => {
        console.log('Successfully added shipping method');
        this.basket_total = res.data.total;
        console.log(`Cart total $${this.basket_total}`);
        return Promise.resolve(this.basket_total);
      })
      .catch((e) => {
        console.error(e);
        return Promise.reject(e);
      });
  }

  async tokenizeCcNum() {
    console.log('Tokenizing credit card number');
    await this.prolific_transport.request({
      method: 'post',
      url: 'https://hostedpayments.radial.com/hosted-payments/pan/tokenize',
      params: {
        access_token: this.basket_nonce,
      },
      data: {
        paymentAccountNumber: this.cc_num,
      },
    })
      .then((res) => {
        console.log('Successfully tokenized cc number');
        this.cc_token = res.data.account_token;
        return Promise.resolve(this.cc_token);
      })
      .catch((e) => {
        console.error(e);
        return Promise.reject(e);
      });
  }

  async encryptCcCvv() {
    console.log('Encrypting credit card');
    await this.prolific_transport.request({
      method: 'post',
      url: 'https://hostedpayments.radial.com/hosted-payments/encrypt/pancsc',
      params: {
        access_token: this.basket_nonce,
      },
      data: {
        paymentAccountNumber: this.cc_num,
        cardSecurityCode: this.cvv,
      },
    })
      .then((res) => {
        console.log('Successfully encrypted credit card');
        this.encrypted_cc = res.data.encryptedPaymentAccountNumber;
        this.encrypted_cvv = res.data.encryptedCardSecurityCode;
        return Promise.resolve(this.encrypted_cvv);
      })
      .catch((e) => {
        console.error(e);
        return Promise.reject(e);
      });
  }

  async addPaymentMethod() {
    console.log('Adding payment method');
    await this.prolific_transport.request({
      method: 'post',
      url: `/ecommerce/cart/${this.basket_id}/payment_methods`,
      data: {
        encryptedCVNValue: this.encrypted_cvv,
        amount: this.basket_total,
        type: 'CREDIT_CARD',
        paymentObject: {
          nameOnCard: `${this.first_name} ${this.last_name}`,
          number: `************${this.cc_num.slice(12)}`,
          expirationYear: parseInt(this.cc_exp_y, 10),
          cardType: this.cc_type,
          expirationMonth: parseInt(this.cc_exp_m, 10),
          creditCardToken: this.cc_token,
        },
      },
    })
      .then(() => {
        console.log('Successfully added payment method');
        return Promise.resolve();
      })
      .catch((e) => {
        console.error(e);
        return Promise.reject(e);
      });
  }

  async submitOrder() {
    console.log('Submitting order');
    await this.prolific_transport.request({
      method: 'post',
      url: `/ecommerce/cart/${this.basket_id}/place_order`,
      params: {
        phone: '',
        optIn: false,
        firstName: '',
        customerId: this.customer_id,
      },
    })
      .then((res) => {
        console.log('Submitted order');
        console.log(res.data);
        return Promise.resolve();
      })
      .catch((e) => {
        if (e.response) {
          if (e.response.status === 400) {
            console.error('Card declined');
          } else {
            console.error(e);
          }
        }
        return Promise.reject(e);
      });
  }

  async waitForDrop() {
    console.log(`Waiting for drop time ${this.profile.drop_time}`);
    const dropTime = new Date(this.profile.drop_time);
    return new Promise((resolve) => {
      setInterval(() => {
        const delta = dropTime.getTime() - new Date().getTime();
        if (delta <= 0) {
          resolve();
        }
      }, 1000);
    });
  }

  async run() {
    console.time(this.uuid);
    try {
      switch (this.mode) {
        case 1:
          // TODO: work on the order of therse methods in mode 1
          console.log(`Worker ${this.uuid} running in ${chalk.green('guest mode')}`);
          await this.guestLogin()
            .catch(() => {
              throw new Error('Unable to guest login');
            });
          await this.createNewBasket()
            .catch(() => {
              throw new Error('Unable to create new basket');
            });
          await this.getPids()
            .catch(() => {
              throw new Error('Unable to get pids');
            });
          await this.selectPid()
            .catch(() => {
              throw new Error('Unable to select pid');
            });
          await this.addEmail()
            .catch(() => {
              throw new Error('Unable to add email');
            });
          await this.addShippingAddress()
            .catch(() => {
              throw new Error('Unable to add shipping address');
            });
          await this.waitForDrop()
            .catch(() => {
              throw new Error('Unable to wait for drop time');
            });
          await this.addToCart()
            .catch(() => {
              throw new Error('Unable to add to cart');
            });
          await this.addShippingMethod()
            .catch(() => {
              throw new Error('Unable to add shipping method');
            });
          await this.getCartNonce()
            .catch(() => {
              throw new Error('Unable to get cart nonce');
            });
          await this.tokenizeCcNum()
            .catch(() => {
              throw new Error('Unable to tokenize cc');
            });
          await this.encryptCcCvv()
            .catch(() => {
              throw new Error('Unable to encrypt cc and cvv');
            });
          await this.addPaymentMethod()
            .catch(() => {
              throw new Error('Unable to add payment method');
            });
          await this.submitOrder()
            .catch(() => {
              throw new Error('Unable to submit order');
            });
          break;
        case 2:
          console.log(`Worker ${this.uuid} running in ${chalk.green('login release mode')}`);
          await this.login()
            .catch(() => {
              throw new Error('Unable to login');
            });
          await this.getBasketIdForUser()
            .catch(() => {
              throw new Error('Unable to get basket id for user');
            });
          await this.addEmail()
            .catch(() => {
              throw new Error('Unable to add email');
            });
          await this.addShippingAddress()
            .catch(() => {
              throw new Error('Unable to add shipping address');
            });
          await this.addShippingMethod()
            .catch(() => {
              throw new Error('Unable to add shipping method');
            });
          await this.getCartNonce()
            .catch(() => {
              throw new Error('Unable to get cart nonce');
            });
          await this.tokenizeCcNum()
            .catch(() => {
              throw new Error('Unable to tokenize cc number');
            });
          await this.encryptCcCvv()
            .catch(() => {
              throw new Error('Unable to encrypt cc and cvv');
            });
          await this.addPaymentMethod()
            .catch(() => {
              throw new Error('Unable to add payment method');
            });
          await this.waitForDrop()
            .catch(() => {
              throw new Error('Unable to wait for drop time');
            });
          await this.submitOrder()
            .catch(() => {
              throw new Error('Unable to submit order');
            });
          break;
        case 3:
          console.log(`Worker ${this.uuid} running in ${chalk.green('restock mode')}`);
          console.error(chalk.red('NOT IMPLEMENTED'));
          break;
        default:
          console.error(`Worker ${this.uuid} has ${chalk.red('unrecognized mode')}`);
          break;
      }
    } catch (e) {
      console.error(e.message);
    }
    console.timeEnd(this.uuid);
  }
}

module.exports = Worker;
