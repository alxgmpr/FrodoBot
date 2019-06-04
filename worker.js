

const puppeteer = require('puppeteer');

const iPhone = puppeteer.devices['iPhone X'];
const { TimeoutError } = require('puppeteer/Errors');
const axios = require('axios');
const httpsProxyAgent = require('https-proxy-agent');
const chalk = require('chalk');
const uuidv4 = require('uuid/v4');

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

    (function (uuid) {
      if (console.log) {
        const old = console.log;
        console.log = function () {
          Array.prototype.unshift.call(arguments, `[${uuid}] `);
          old.apply(this, arguments);
        };
      }
      if (console.warn) {
        const old = console.warn;
        console.warn = function () {
          Array.prototype.unshift.call(arguments, `[${chalk.red(uuid)}] `);
          old.apply(this, arguments);
        };
      }
      if (console.error) {
        const old = console.error;
        console.error = function () {
          Array.prototype.unshift.call(arguments, `[${chalk.red(uuid)}] `);
          old.apply(this, arguments);
        };
      }
    }(this.uuid));

    this.profile = profile;

    this.mobile_user_agent = 'Hibbett/3.9.0 (com.hibbett.hibbett-sports; build:4558; iOS 12.2.0) Alamofire/4.5.1';

    this.app_version = '3.9.0';
    this.api_key = '0PutYAUfHz8ozEeqTFlF014LMJji6Rsc8bpRBGB0';

    const axios_options = {
      baseURL: 'https://hibbett-mobileapi.prolific.io/',
      headers: {
        'user-agent': this.mobile_user_agent,
        'accept-language': 'en-US;q=1.0',
        'accept-encoding': 'gzip;q=1.0, compress;q=0.5',
        'content-type': 'application/json; charset=utf-8',
        accept: '*/*',
        version: this.app_version,
        platform: 'ios',
        'x-api-key': this.api_key,
      },
      withCredentials: true,

    };

    if (this.profile.proxy !== '' && this.profile.proxy) {
      axios_options.httpsAgent = new httpsProxyAgent(`http://${this.profile.proxy}`);
    }

    this.prolific_transport = axios.create(axios_options);
    // Custom error handling for 403 blocking and 5xx server downtime
    this.prolific_transport.interceptors.response.use(null, async (error) => {
      if (error.config && error.response && error.response.status === 403) {
        console.error('PX block, updating token');
        await this.get_new_px();
        return await this.prolific_transport.request({
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
        return await this.prolific_transport.request({
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
    get_new_px() - uses puppeteer to grab cookies via a headless browser
     */
  async get_new_px() {
    // TODO: set a 10minute timer here to renew the auth key every now and then
    //  - potentially change the endpoint?
    //  - potentially change the timeout here
    //  - add mouse movement/activity
    //  - add page scroll movement/activity
    try {
      console.log('PX: Starting');

      const pptr_config = {
        headless: true,
        ignoreHTTPSErrors: true,
      };

      if (this.profile.proxy && this.profile.proxy !== '') {
        pptr_config.args = [`--proxy-server=${this.profile.proxy}`];
      }

      const browser = await puppeteer.launch(pptr_config);
      // console.log('PX: Preparing browser');
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
            await this.get_new_px();
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
            this.prolific_transport.defaults.headers['x-px-authorization'] = `3:${
              this.cookies.filter(cookie => cookie.name === '_px3')[0].value}`;
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
            await this.get_new_px();
          }
        }
      });
    } catch (e) {
      console.error(e);
    }
  }

  async guest_login() {
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
    logout() - method to log out of a logged in account. note that this will invalidate the session so further requests
    will need to be authenticated by login() or guest_login()
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

  async get_pids() {
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

  async select_pid() {
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

  async get_basket_id_for_user() {
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
  }

  async create_new_basket() {
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
  }

  async add_to_cart() {
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
  }

  async get_cart_nonce() {
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
  }

  async add_email() {
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

  async add_shipping_address() {
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

  async add_shipping_method() {
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

  async tokenize_cc_num() {
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

  async encrypt_cc_cvv() {
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

  async add_payment_method() {
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
          expirationYear: parseInt(this.cc_exp_y),
          cardType: this.cc_type,
          expirationMonth: parseInt(this.cc_exp_m),
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

  async submit_order() {
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

  async wait_for_drop() {
    console.log(`Waiting for drop time ${this.profile.drop_time}`);
    const drop_time = new Date(this.profile.drop_time);
    return new Promise((resolve) => {
      setInterval(() => {
        const delta = drop_time.getTime() - new Date().getTime();
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
          await this.guest_login()
            .catch(() => {
              throw new Error('Unable to guest login');
            });
          await this.create_new_basket()
            .catch(() => {
              throw new Error('Unable to create new basket');
            });
          await this.get_pids()
            .catch(() => {
              throw new Error('Unable to get pids');
            });
          await this.select_pid()
            .catch(() => {
              throw new Error('Unable to select pid');
            });
          await this.add_email()
            .catch(() => {
              throw new Error('Unable to add email');
            });
          await this.add_shipping_address()
            .catch(() => {
              throw new Error('Unable to add shipping address');
            });
          await this.wait_for_drop()
            .catch(() => {
              throw new Error('Unable to wait for drop time');
            });
          await this.add_to_cart()
            .catch(() => {
              throw new Error('Unable to add to cart');
            });

          await this.add_shipping_method()
            .catch(() => {
              throw new Error('Unable to add shipping method');
            });
          await this.get_cart_nonce()
            .catch(() => {
              throw new Error('Unable to get cart nonce');
            });
          await this.tokenize_cc_num()
            .catch(() => {
              throw new Error('Unable to tokenize cc');
            });
          await this.encrypt_cc_cvv()
            .catch(() => {
              throw new Error('Unable to encrypt cc and cvv');
            });
          await this.add_payment_method()
            .catch(() => {
              throw new Error('Unable to add payment method');
            });

          await this.submit_order()
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
          await this.get_basket_id_for_user()
            .catch(() => {
              throw new Error('Unable to get basket id for user');
            });
          await this.add_email()
            .catch(() => {
              throw new Error('Unable to add email');
            });
          await this.add_shipping_address()
            .catch(() => {
              throw new Error('Unable to add shipping address');
            });
          await this.add_shipping_method()
            .catch(() => {
              throw new Error('Unable to add shipping method');
            });
          await this.get_cart_nonce()
            .catch(() => {
              throw new Error('Unable to get cart nonce');
            });
          await this.tokenize_cc_num()
            .catch(() => {
              throw new Error('Unable to tokenize cc number');
            });
          await this.encrypt_cc_cvv()
            .catch(() => {
              throw new Error('Unable to encrypt cc and cvv');
            });
          await this.add_payment_method()
            .catch(() => {
              throw new Error('Unable to add payment method');
            });
          await this.wait_for_drop()
            .catch(() => {
              throw new Error('Unable to wait for drop time');
            });
          await this.submit_order()
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
