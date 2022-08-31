require('dotenv').config();

// Express Setup
const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 8001;

// Stripe Setup
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SK);

// Airtable Setup
const Airtable = require('airtable');
Airtable.configure({
    endpointUrl: 'https://api.airtable.com',
    apiKey: process.env.AIRTABLE_API_KEY
});
var base = Airtable.base('appnd07W3kXMlULQl');


// Mailgun Setup
const formData = require('form-data');
const Mailgun = require('mailgun.js');
const mailgun = new Mailgun(formData);
const mg = mailgun.client({username: 'api', key: process.env.MAILGUN_API_KEY});


// Function to set date for subscription start.
const handleDate = () => {
	let now = new Date();
	let current_month = now.getMonth();
	let current_year = now.getFullYear();
	let renewal_year = current_month < 6 ? current_year : current_year + 1;
	let renewal_date = new Date(`July 1, ${renewal_year}, 12:00:00`);
	return parseInt(renewal_date.getTime() / 1000);
}


// Express Middleware
app.use(cors());
app.use(express.json());


//
// Routes
//
app.get("/", (req, res) => {
	res.send("Wakeup.");
});

app.post('/create-subscription', async (req, res) => {
	console.log(req.body);
	const { priceId, start, name, email, address, paymentMethod } = req.body;

	try {
		console.log("Checking for Existing Customer");
		const existing_customer = await stripe.customers.list({email: email});
		console.log(existing_customer);
		if (existing_customer.data.length > 0) {
			console.log(`Existing Customer: ${email}`);
			throw { existing_customer: true };
		}
	} catch (error) {
		res.send(error);
		return;
	}

	try {
		const customer = await stripe.customers.create({
			name: name,
			email: email,
			address: address
		});

		if (paymentMethod) {
			const pm = await stripe.paymentMethods.attach(
				paymentMethod,
				{customer: customer.id}
			);
	
			await stripe.customers.update(customer.id, {
				invoice_settings: {
					default_payment_method: paymentMethod
				}
			});
		}


		console.log(`Customer created: ${customer.id}`);

		const sub_data = {
			customer: customer.id,
			items: [{
				price: priceId,
			}],
			payment_behavior: 'default_incomplete',
			expand: ['latest_invoice.payment_intent'],
			metadata: {
					start: start
				}
			}

			if (start === "next") {
				sub_data.billing_cycle_anchor = handleDate();
				sub_data.proration_behavior = "none";
				if (paymentMethod) {
					sub_data.default_payment_method = paymentMethod;
				}
			}

			try {
				const subscription = await stripe.subscriptions.create(sub_data);

				console.log("Subscription created.");
				console.log({subscription});

				
				if (subscription.latest_invoice && subscription.latest_invoice.payment_intent) {
					console.log("Sending client secret.");
					res.send({
						start: start,
						subscriptionId: subscription.id,
						clientSecret: subscription.latest_invoice.payment_intent.client_secret
					});
				} else {
					console.log("Sending success message.");
					res.send({
						start: start,
						subscriptionId: subscription.id
					});
					if (start === "next") {
						mg.messages.create('mg.fallowmedia.com', {
							from: "Holy Show Subs <holyshow@mg.fallowmedia.com>",
							to: email,
							subject: "You've subscribed to Holy Show Magazine",
							text: `Dear ${customer.name}, thanks for subscribing to Holy Show.\n\nYYour subscription starts with the next issue, so you won't be charged until 1 July. We'll send you an email in advance to confirm your address before posting out the issue.\n\nIf you intended to buy the current issue, you can pick that up here: https://holyshow.ie/shop-1\n\nThanks again for the support!\n\nRegards,\nThe Holy Show Team`,
							html: `<p>Dear ${customer.name}, thanks for subscribing to Holy Show.</p><p>Your subscription starts with the next issue, so you won't be charged until 1 July. We'll send you an email in advance to confirm your address before posting out the issue.</p><p>If you intended to buy the current issue, you can pick that up here: <a href="https://holyshow.ie/shop-1">https://holyshow.ie/shop-1</a></p><p>Thanks again for the support!</p><p>Regards,<br>The Holy Show Team</p>`,
						}).then(msg => console.log(msg)).catch(err => console.log(err));
					}
				}
			} catch (error) {
				console.log(error);
				res.send(error);
			}
		} catch (error) {
		console.log(error);
		res.send(error);
	}
});


// Listen for webhook events.
app.post('/webhooks', async (req, res) => {
  let event;

  try {
    event = req.body;
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const handleNewSubscription = async subscription => {
	console.log("Setting up new customer");
	const customer = await stripe.customers.retrieve(subscription.customer);

	// Function to format the Stripe subscription created date correctly for storage in Airtable.
	let formatDateForAirtable = (date) => {
		let ms = date * 1000;
		let d = new Date(ms);
		return d.toISOString();
	}

	if (customer.address) {
		console.log("Adding to Airtable");
		// This logs the subscriber data to the Airtable database.
		base(process.env.AIRTABLE_TABLE).create([
			{
				"fields": {
					Subscription: subscription.id,
					Email: customer.email,
					Name: customer.name,
					"Address Line One": customer.address.line1,
					"Address Line Two": customer.address.line2,
					City: customer.address.city,
					Postcode: customer.address.postal_code,
					Country: customer.address.country,
					"Starts With": subscription.metadata.start,
					Created: formatDateForAirtable(subscription.created)
				}
			}
			], {typecast: true}, function(err, records) {
			if (err) {
				console.error(err);
				return;
			}
			records.forEach(function (record) {
				console.log("Airtable Log:" + record.getId());
			});
		});
		
		// This sends the admin notification email.
		mg.messages.create('mg.fallowmedia.com', {
			from: "Holy Show Subs <holyshow@mg.fallowmedia.com>",
			to: process.env.ADMIN_EMAIL,
			subject: "New Subscriber",
			text: `Hey, Holy Show has a new subscriber.\n\n ${customer.name} is their name. Their subscription starts with the ${subscription.metadata.start} issue. \n\nYou'll find more details in the Airtable spreadsheet: https://airtable.com/shrYoZWugZisDZVnj`,
			html: `<p>Hey, you've got a new subscriber.</p><p>${customer.name} is their name. Their subscription starts with the ${subscription.metadata.start} issue.</p><p>You'll find more details in <a href="https://airtable.com/shrYoZWugZisDZVnj">the Airtable spreadsheet</a>.</p>`,
		}).then(msg => console.log(msg)).catch(err => console.log(err));
	}


	  

  }

  const handleTrialWillEnd = async (sub_data) => {
	console.log(sub_data);
  }

  const handlePaymentFailed = async (invoice_data) => {
	let {customer, subscription, customer_email} = invoice_data;
	console.log("Payment Failed: ", customer, subscription, customer_email);
  }

  const handlePaymentSuccess = async (payment_intent) => {
	const invoice_data = await stripe.invoices.retrieve(payment_intent.invoice);

	if (!invoice_data) {
		console.log("No invoice found.");
		console.log({payment_intent});
		return;
	}

	if (invoice_data.billing_reason !== "subscription_create") {
		return;
	}

	const subscription = await stripe.subscriptions.retrieve(invoice_data.subscription);

	if (!subscription) {
		console.log("No subscription found.");
		console.log({invoice_data});
		return;
	}

	// This resets the billing anchor to the 1st of next July, after the customer has already been charged for the current issue.
	if (subscription.metadata.start === 'current') {
		await stripe.subscriptions.update(subscription.id, {
			trial_end: handleDate(),
			proration_behavior: 'none',
		});
		console.log("Subscription Updated");
		console.log({subscription});
	}
	
}

  // Handle the event
  switch (event.type) {
    case 'customer.subscription.created':
      const newSubscriber = event.data.object;
	  handleNewSubscription(newSubscriber);
      break;
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
	  handlePaymentSuccess(paymentIntent);
      break;
    case 'customer.subscription.trial_will_end':
      let sub_data = event.data.object;
	  handleTrialWillEnd(sub_data);
      break;
    case 'invoice.payment_failed':
      let invoice_data = event.data.object;
	  handlePaymentFailed(invoice_data);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  // Return a response to acknowledge receipt of the event
  res.json({received: true});
});


// Start the app.
app.listen(port, () => {
  console.log(`App listening at http://localhost:${port}`);
});