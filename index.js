require('dotenv').config();

// Express Setup
const express = require('express');
const cors = require('cors');
const app = express();
const port = 12345;

// Stripe Setup
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SK);
const {cc} = require('./cc');

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

// Create the checkout session.
app.post('/create-checkout-session', async (req, res) => {
  const { priceId, start } = req.body;

  let sub_data = {
	metadata: {
		start: start
	}
  };

  if (start === "next") {
	  sub_data.trial_end = handleDate();
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
	  payment_method_types: ["card"],
	  billing_address_collection: 'auto',
	  shipping_address_collection: {
		  allowed_countries: cc
		},
	  subscription_data: sub_data,
      line_items: [
        {
		  price: priceId,
		  quantity: 1
        },
      ],
      success_url: `${process.env.BASE_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/`,
	});

    res.send({
      sessionId: session.id,
	});
	
  } catch (e) {
    res.status(400);
    return res.send({
      error: {
        message: e.message,
      }
    });
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

  const handleCheckoutSession = async checkoutSession => {

	const subscription = await stripe.subscriptions.retrieve(checkoutSession.subscription);

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
				Email: checkoutSession.customer_details.email,
				Name: checkoutSession.shipping.name,
				"Address Line One": checkoutSession.shipping.address.line1,
				"Address Line Two": checkoutSession.shipping.address.line2,
				City: checkoutSession.shipping.address.city,
				Postcode: checkoutSession.shipping.address.postal_code,
				Country: checkoutSession.shipping.address.country,
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
		text: `Hey, Holy Show has a new subscriber.\n\n ${checkoutSession.shipping.name} is their name. Their subscription starts with the ${subscription.metadata.start} issue. \n\nYou'll find more details in the Airtable spreadsheet: https://airtable.com/tblZ5XPwTRUqfpLxw/viwLfTHRQv2hgu4uK?blocks=hide`,
		html: `<p>Hey, you've got a new subscriber.</p><p>${checkoutSession.shipping.name} is their name. Their subscription starts with the ${subscription.metadata.start} issue.</p><p>You'll find more details in <a href="https://airtable.com/tblZ5XPwTRUqfpLxw/viwLfTHRQv2hgu4uK?blocks=hide">the Airtable spreadsheet</a>.</p>`,
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
    case 'checkout.session.completed':
      const checkoutSession = event.data.object;
	  handleCheckoutSession(checkoutSession);
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