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
	res.send("Hello world.");
});

app.post('/create-subscription', async (req, res) => {
	const { priceId, start, name, email, address } = req.body;

	try {
		const customer = await stripe.customers.create({
			name: name,
			email: email,
			address: address
		});
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
				sub_data.trial_end = handleDate();
			}

			try {
				const subscription = await stripe.subscriptions.create(sub_data);

				console.log({subscription});

				res.send({
				  subscriptionId: subscription.id,
				  clientSecret: subscription.latest_invoice.payment_intent.client_secret,
				});
				
			} catch (error) {
				res.send(error);
			}
	} catch (error) {
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

	const customer = await stripe.customers.retrieve(subscription.customer);

	// This resets the billing anchor to the 1st of next July, after the customer has already been charged for the current issue.
	if (subscription.metadata.start === 'current') {
		await stripe.subscriptions.update(subscription.id, {
			trial_end: handleDate(),
			proration_behavior: 'none',
		});
	}


	// Function to format the Stripe subscription created date correctly for storage in Airtable.
	let formatDateForAirtable = (date) => {
		let ms = date * 1000;
		let d = new Date(ms);
		return d.toISOString();
	}

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

  const handleTrialWillEnd = async (sub_data) => {
	console.log(sub_data);
  }

  const handlePaymentFailed = async (invoice_data) => {
	let {customer, subscription, customer_email} = invoice_data;
	console.log(customer, subscription, customer_email);
  }

  // Handle the event
  switch (event.type) {
    case 'customer.subscription.created':
      const newSubscriber = event.data.object;
	  handleNewSubscription(newSubscriber);
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