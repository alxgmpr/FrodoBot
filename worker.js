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

class Worker {
  constructor(profile) {
    this.uuid = Buffer.from(uuidv4().replace(/-/g, '').slice(0, 8)).toString('base64');

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
        if (this.times_px_requested > 10) {
          this.error('PX: Requested more than 10 times, exiting request');
          return Promise.reject();
        }
        this.error('PX: Block, updating token');
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
        this.error(`${error.repsonse.status} server error, repeating request`);
        return this.prolific_transport.request({
          method: error.config.method,
          url: error.config.url,
          params: error.config.params,
          withCredentials: true,
        });
      }
      // Authentication has expired
      if (error.config && error.response && error.response.status === 401) {
        this.error('401 Invalid session, updating auth');
        if (this.profile.password && this.profile.password !== '') {
          await this.login();
        } else {
          await this.guestLogin();
        }
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

    this.times_px_requested = 0;
  }

  log(text) {
    return console.log(`[${this.uuid}] ${text}`);
  }

  debug(text) {
    return console.debug(`[${chalk.magenta(this.uuid)}] ${text}`);
  }

  warn(text) {
    return console.warn(`[${chalk.yellow(this.uuid)}] ${text}`);
  }

  error(text) {
    return console.error(`[${chalk.red(this.uuid)}] ${text}`);
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
      this.log('PX: Starting');

      const pptrConfig = {
        headless: true,
        ignoreHTTPSErrors: true,
      };

      if (this.profile.proxy && this.profile.proxy !== '') {
        if (this.profile.proxy.indexOf('@') === -1) {
          pptrConfig.args = [`--proxy-server=${this.profile.proxy}`];
        } else {
          pptrConfig.args = [`--proxy-server=${this.profile.proxy.split('@')[1]}`];
        }
      }

      const browser = await puppeteer.launch(pptrConfig);
      const context = await browser.createIncognitoBrowserContext();
      const page = await context.newPage();
      if (this.profile.proxy.indexOf('@') !== -1) {
        await page.authenticate({
          username: this.profile.proxy.split(':')[0],
          password: this.profile.proxy.split(':')[1].split('@')[0],
        });
      }
      await page.emulate(iPhone);
      await page.setJavaScriptEnabled(true);

      // load the page
      await page.goto('https://hibbett-mobileapi.prolific.io/ecommerce/shopview')
        .then(async (response) => {
          this.log(`PX: Initial response code: ${await response.headers().status}`);
        })
        .catch(async (e) => {
          if (e instanceof TimeoutError) {
            this.warn('PX: timeout, restarting');
            browser.close();
            await this.getNewPxToken();
          }
        });

      // we probably get a 403 block by px so wait 10 sec and reload
      await page.waitFor(10000);

      await page.reload().then(async (response) => {
        const responseCode = await response.headers().status;
        if (responseCode === '200') {
          this.log(chalk.green('PX: Final response code: 200'));
          try {
            this.cookies = await page.cookies();
            this.prolific_transport.defaults.headers['x-px-authorization'] = `3:${this.cookies.filter(cookie => cookie.name === '_px3')[0].value}`;
            await browser.close();
          } catch (e) {
            this.error(e);
          }
        } else {
          this.error(`PX: Failed to get a good 200 status code after 10sec reload: ${responseCode}`);
          if (responseCode === 403) {
            this.log('PX: Retrying with "longer" delay');
            // TODO: increase delay here
            await browser.close();
            await this.getNewPxToken();
          }
        }
      });
    } catch (e) {
      this.error(e);
    }
  }

  async guestLogin() {
    this.log('Getting guest authorization');
    await this.prolific_transport.request({
      method: 'post',
      url: '/users/guest',
    })
      .then((res) => {
        this.log('Setting guest authorization header');
        this.session_id = res.data.sessionId;
        this.prolific_transport.defaults.headers.authorization = `Bearer ${res.data.sessionId}`;
        return Promise.resolve(this.session_id);
      })
      .catch((e) => {
        this.error(e);
        return Promise.reject(e);
      });
  }

  async login() {
    this.log(`Logging into account ${chalk.cyan(this.email)}`);
    await this.prolific_transport.request({
      method: 'post',
      url: '/users/login',
      data: {
        password: this.password,
        login: this.email,
      },
    })
      .then((res) => {
        this.log('Setting user authorization header');
        this.session_id = res.data.sessionId;
        this.prolific_transport.defaults.headers.authorization = `Bearer ${res.data.sessionId}`;
        this.log(`Setting customer id ${res.data.customerId}`);
        this.customer_id = res.data.customerId;
        return Promise.resolve();
      })
      .catch((e) => {
        if (e.response && e.response.status === 401) {
          this.error('Bad login');
          return Promise.reject();
        }
        this.error(e);
        return Promise.reject();
      });
  }

  /*
    logout() - method to log out of a logged in account. note that this will invalidate the session
    so further requests will need to be authenticated by login() or guestLogin()
     */
  async logout() {
    try {
      this.log('Logging out');
      const response = await this.prolific_transport.request({
        method: 'delete',
        url: '/users/logout',
      });
      if (response.data.success === true) {
        this.log('Successfully logged out');
        return Promise.resolve();
      }
      this.log('Logout response unsuccessful');
      return Promise.reject();
    } catch (e) {
      this.error(e);
      return Promise.reject(e);
    }
  }

  async getPids() {
    this.log(`getting pids for ${this.master_pid}`);
    await this.prolific_transport.request({
      method: 'get',
      url: `/ecommerce/products/${this.master_pid}`,
    })
      .then((res) => {
        this.pids = res.data.skus;
        return Promise.resolve(this.pids);
      })
      .catch((e) => {
        this.error(e);
        return Promise.reject(e);
      });
  }

  async selectPid() {
    this.log(`Selecting sku based on target size ${this.target_size}`);
    if (!this.pids) {
      this.error('Cant select a size from empty list of pids');
      return Promise.reject();
    }
    try {
      const selected = this.pids.filter(pid => pid.size === this.target_size)[0];
      this.sel_pid = selected.id;
      this.log(`Selected ${selected.id} for size ${this.target_size}`);
      return Promise.resolve(selected);
    } catch (e) {
      this.error(e);
      return Promise.reject();
    }
  }

  async getBasketIdForUser() {
    if (!this.customer_id) {
      this.error('Cant find a basket id without customer id');
      return Promise.reject();
    }
    this.log('Finding existing basket for user');
    await this.prolific_transport.request({
      method: 'get',
      url: `users/${this.customer_id}/basketId`,
    })
      .then((res) => {
        this.log(`Found existing basket id ${res.data.basketId}`);
        this.basket_id = res.data.basketId;
      })
      .catch((e) => {
        this.error(e);
        return Promise.reject(e);
      });
    return Promise.resolve(this.basket_id);
  }

  async createNewBasket() {
    this.log('Creating a new basket');
    await this.prolific_transport.request({
      method: 'post',
      url: '/ecommerce/cart/create',
    })
      .then((res) => {
        this.basket_id = res.data.basketId;
        this.log(`Got a new basket id ${this.basket_id}`);
        return Promise.resolve(this.basket_id);
      })
      .catch((e) => {
        this.log(e);
        return Promise.reject(e);
      });
    return Promise.reject();
  }

  async addToCart() {
    if (!this.sel_pid || !this.basket_id) {
      this.error('Cant atc, missing pid or basket id');
      return Promise.reject();
    }
    this.log('Adding to cart');
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
        this.log(`Added ${this.sel_pid} to cart`);
        this.product_id = res.data.cartItems[0].id;
        return Promise.resolve(this.product_id);
      })
      .catch((e) => {
        this.error(e);
        return Promise.reject(e);
      });
    return Promise.reject();
  }

  async getCartNonce() {
    if (!this.basket_id) {
      this.error('Cant get cart nonce for null basket id');
      return Promise.reject();
    }
    this.log('Getting cart nonce');
    await this.prolific_transport.request({
      method: 'get',
      url: `/ecommerce/cart/${this.basket_id}/viewBag`,
      params: {
        customerId: this.customer_id ? this.customer_id : '',
      },
    })
      .then((res) => {
        this.log('Got cart nonce');
        this.basket_nonce = res.data.nonce;
      })
      .catch((e) => {
        this.error(e);
        return Promise.reject(e);
      });
    return Promise.resolve(this.basket_nonce);
  }

  async addEmail() {
    this.log('Adding email');
    await this.prolific_transport.request({
      method: 'put',
      url: `/ecommerce/cart/${this.basket_id}/customer`,
      data: {
        email: this.email,
      },
    })
      .then(() => {
        this.log('Successfully added email');
        return Promise.resolve();
      })
      .catch((e) => {
        this.error(e);
        Promise.reject(e);
      });
  }

  async addShippingAddress() {
    this.log('Adding shipping address');
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
        this.log('Successfully added shipping address');
        return Promise.resolve();
      })
      .catch((e) => {
        this.error(e);
        return Promise.reject(e);
      });
  }

  async addShippingMethod() {
    this.log('Adding shipping method');
    await this.prolific_transport.request({
      method: 'put',
      url: `/ecommerce/cart/${this.basket_id}/shipments/me/shipping_options`,
      data: {
        id: 'ANY_GND',
      },
    })
      .then((res) => {
        this.log('Successfully added shipping method');
        this.basket_total = res.data.total;
        this.log(`Cart total $${this.basket_total}`);
        return Promise.resolve(this.basket_total);
      })
      .catch((e) => {
        this.error(e);
        return Promise.reject(e);
      });
  }

  async tokenizeCcNum() {
    this.log('Tokenizing credit card number');
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
        this.log('Successfully tokenized cc number');
        this.cc_token = res.data.account_token;
        return Promise.resolve(this.cc_token);
      })
      .catch((e) => {
        this.error(e);
        return Promise.reject(e);
      });
  }

  async encryptCcCvv() {
    this.log('Encrypting credit card');
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
        this.log('Successfully encrypted credit card');
        this.encrypted_cc = res.data.encryptedPaymentAccountNumber;
        this.encrypted_cvv = res.data.encryptedCardSecurityCode;
        return Promise.resolve(this.encrypted_cvv);
      })
      .catch((e) => {
        this.error(e);
        return Promise.reject(e);
      });
  }

  async addPaymentMethod() {
    this.log('Adding payment method');
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
        this.log('Successfully added payment method');
        return Promise.resolve();
      })
      .catch((e) => {
        this.error(e);
        return Promise.reject(e);
      });
  }

  async submitOrder() {
    this.log('Submitting order');
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
        this.log(chalk.green(`Submitted order ${res.data.id}`));
        return Promise.resolve();
      })
      .catch((e) => {
        if (e.response) {
          if (e.response.status === 400) {
            this.error('Card declined');
          } else {
            this.error(e);
          }
        }
        return Promise.reject(e);
      });
  }

  async waitForDrop() {
    this.log(`Waiting for drop time ${this.profile.drop_time}`);
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
    console.time(`[${this.uuid}] `);
    try {
      switch (this.mode) {
        case 1:
          // TODO: work on the order of therse methods in mode 1
          this.log(`Worker ${this.uuid} running in ${chalk.green('guest mode')}`);
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
          this.log(`Worker ${this.uuid} running in ${chalk.green('login release mode')}`);
          await this.login()
            .catch(() => {
              throw new Error('Unable to login');
            });
          await this.getBasketIdForUser()
            .catch(() => {
              throw new Error('Unable to get basket id for user');
            });
          // await this.addEmail()
          //   .catch(() => {
          //     throw new Error('Unable to add email');
          //   });
          // await this.addShippingAddress()
          //   .catch(() => {
          //     throw new Error('Unable to add shipping address');
          //   });
          // await this.addShippingMethod()
          //   .catch(() => {
          //     throw new Error('Unable to add shipping method');
          //   });
          // await this.getCartNonce()
          //   .catch(() => {
          //     throw new Error('Unable to get cart nonce');
          //   });
          // await this.tokenizeCcNum()
          //   .catch(() => {
          //     throw new Error('Unable to tokenize cc number');
          //   });
          // await this.encryptCcCvv()
          //   .catch(() => {
          //     throw new Error('Unable to encrypt cc and cvv');
          //   });
          // await this.addPaymentMethod()
          //   .catch(() => {
          //     throw new Error('Unable to add payment method');
          //   });
          // await this.waitForDrop()
          //   .catch(() => {
          //     throw new Error('Unable to wait for drop time');
          //   });
          // await this.submitOrder()
          //   .catch(() => {
          //     throw new Error('Unable to submit order');
          //   });
          break;
        case 3:
          this.log(`Worker ${this.uuid} running in ${chalk.green('restock mode')}`);
          this.error(chalk.red('NOT IMPLEMENTED'));
          break;
        default:
          this.error(`Worker ${this.uuid} has ${chalk.red('unrecognized mode')}`);
          break;
      }
    } catch (e) {
      this.error(e.message);
    }
    console.timeEnd(`[${this.uuid}] `);
    return Promise.resolve();
  }
}

module.exports = Worker;
