import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
//import * as storage from 'firebase-storage'
//import { getStorage, ref, uploadBytes } from 'firebase/storage'
const { CloudTasksClient } = require('@google-cloud/tasks')
//import { Blob } from 'buffer'
// const { Logging } = require('@google-cloud/logging');
// const logging = new Logging({
//   projectId: process.env.GCLOUD_PROJECT,
// });
 
const { Stripe } = require('stripe');
const stripe = new Stripe(functions.config().stripe.secret, {
 apiVersion: '2020-08-27',
});
admin.initializeApp()
 
 
// function userFacingMessage(error: Error) {
//     return error.name
//       ? error.message
//       : 'An error occurred, developers have been alerted';
//   }
 exports.createStripeCustomer = functions.auth.user().onCreate(async (user) => {
   const customer = await stripe.customers.create({ email: user.email });
   const intent = await stripe.setupIntents.create({
     customer: customer.id,
   });
   await admin.firestore().collection('stripe_customers').doc(user.uid).set({
     customer_id: customer.id,
     setup_secret: intent.client_secret,
   });
   return;
 });


exports.addPaymentMethodDetails = functions.firestore
 .document('/stripe_customers/{userId}/payment_methods/{pushId}')
 .onCreate(async (snap, context) => {
   try {
     const paymentMethodId = snap.data().id;
     const paymentMethod = await stripe.paymentMethods.retrieve(
       paymentMethodId
     );
     await snap.ref.set(paymentMethod);
     // Create a new SetupIntent so the customer can add a new method next time.
     const intent = await stripe.setupIntents.create({
       customer: `${paymentMethod.customer}`,
     });
     await snap.ref.parent.parent!.set(
       {
         setup_secret: intent.client_secret,
       },
       { merge: true }
     );
     return;
   } catch (error) {
   //   await snap.ref.set({ error: "userFacingMessage(error)" }, { merge: true });
   //   await reportError(error, { user: context.params.userId });
   }
 });
 
exports.createStripePayment = functions.firestore
 .document('stripe_customers/{userId}/payments/{pushId}')
 .onCreate(async (snap, context) => {
   const { amount, currency, payment_method } = snap.data();
   try {
     // Look up the Stripe customer id.
     const customer = (await snap.ref.parent.parent!.get()).data()!.customer_id;
     // Create a charge using the pushId as the idempotency key
     // to protect against double charges.
     const idempotencyKey = context.params.pushId;
     const payment = await stripe.paymentIntents.create(
       {
         amount,
         currency,
         customer,
         payment_method,
         off_session: false,
         confirm: true,
         confirmation_method: 'manual',
       },
       { idempotencyKey }
     );
     // If the result is successful, write it back to the database.
     await snap.ref.set(payment);
   } catch (error) {
     // We want to capture errors and render them in a user-friendly way, while
     // still logging an exception with StackDriver
   //   functions.logger.log(error);
   //   await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
   //   await reportError(error, { user: context.params.userId });
   console.log(error)
   }
 });
 
exports.confirmStripePayment = functions.firestore
 .document('stripe_customers/{userId}/payments/{pushId}')
 .onUpdate(async (change, context) => {
   if (change.after.data().status === 'requires_confirmation') {
     const payment = await stripe.paymentIntents.confirm(
       change.after.data().id
     );
     change.after.ref.set(payment);
   }
 });
 exports.cleanupUser = functions.auth.user().onDelete(async (user) => {
   const dbRef = admin.firestore().collection('stripe_customers');
   const customer = (await dbRef.doc(user.uid).get()).data();
   await stripe.customers.del(customer!.customer_id);
   // Delete the customers payments & payment methods in firestore.
   const batch = admin.firestore().batch();
   const paymetsMethodsSnapshot = await dbRef
     .doc(user.uid)
     .collection('payment_methods')
     .get();
   paymetsMethodsSnapshot.forEach((snap) => batch.delete(snap.ref));
   const paymentsSnapshot = await dbRef
     .doc(user.uid)
     .collection('payments')
     .get();
   paymentsSnapshot.forEach((snap) => batch.delete(snap.ref));
    await batch.commit();
    await dbRef.doc(user.uid).delete();
   return;
 });
 
 
//MARK: User Status Functions
const firestore = admin.firestore();
 
// Create a new function which is triggered on changes to /status/{uid}.
exports.onUserStatusChanged = functions.database.ref('/users/{uid}').onUpdate(
   async (change, context) => {
       // Get the data written to Realtime Database
       const eventStatus = change.after.val();
 
       // Then use other event data to create a reference to the
       // corresponding Firestore document.
       const userStatusFirestoreRef = firestore.collection("Users").doc(context.params.uid);
 
       // It is likely that the Realtime Database change that triggered
       // this event has already been overwritten by a fast change in
       // online / offline status, so we'll re-read the current data
       // and compare the timestamps.
       const statusSnapshot = await change.after.ref.once('value');
       const status = statusSnapshot.val();
       functions.logger.log(status, eventStatus);
       // If the current timestamp for this data is newer than
       // the data that triggered this event, we exit this function.
       if (status.lastLogin > eventStatus.lastLogin) {
           return null;
       }
 
       // Otherwise, we convert the last_changed field to a Date
       eventStatus.lastLogin = new Date(eventStatus.lastLogin);
 
       // ... and write it to Firestore.
       return userStatusFirestoreRef.update(eventStatus);
   });
 
 
//MARK: Scheduler Functions
 
// Payload of JSON data to send to Cloud Tasks, will be received by the HTTP callback
interface ExpirationTaskPayload {
   docPath: string
   hostDocPath?: string
   state: string
   city: string
   hostID?: string
   hostID_array?: [string]
   venueID?: string //..
   title?: string //..
   description?: string //..
 
   image_url?: string//..
   price?: number //..
   latitude?: number
   longitude?: number//.. //..
   scene?: string//..
   start_time?: admin.firestore.Timestamp//..
   end_time?: admin.firestore.Timestamp//..
   type?: string//..
   capacity?: number//..
   isHidden?: boolean
}
 
interface SimplePayload {
   eventID: string
   uid: string
   eventType: string
   token: string
   title: string
   startTime?: number
}
// class Coordinate {
//     lon!: number;
//     lat!: number;

//     _init(lon: number, lat: number){
//         this.lat = lon
//         this.lat = lat
//     }
// }
type Coordinate = {
    lon: number
    lat: number
}
interface CoordinateWMag {
    lon: number
    lat: number
    mag: number
}

interface CampusPayload {
    campus: string
}
 
// Description of document data that contains optional fields for expiration
interface EventData extends admin.firestore.DocumentData {
   expirationTask?: string
   hostID_array?: [string]
   rsvpIDs?: [string]
   rsvpCount?: number
   venueID?: string //..
   title?: string //..
   description?: string //..
  
   image_url?: string//..
   price?: number //..
   latitude?: number
   longitude?: number//.. //..
   scene?: string//..
   start_time?: admin.firestore.Timestamp//..
   end_time?: admin.firestore.Timestamp//..
   type?: string//..
   capacity?: number//..
   isHidden?: boolean
}
 
export const updateGuestCounts = functions.firestore.document('/Live Events/{state}/{city}/{eventID}/Guests/{uid}').onCreate(
   async (_, context) => {
       let docPath = firestore.doc(`Live Events/${context.params.state}/${context.params.city}/${context.params.eventID}`)
       await docPath.update({"guestCount" : admin.firestore.FieldValue.increment(1)})
   }
)
 
export const removeGuestCounts = functions.firestore.document('/Live Events/{state}/{city}/{eventID}/Guests/{uid}').onDelete(
   async (_, context) => {
       let docPath = firestore.doc(`Live Events/${context.params.state}/${context.params.city}/${context.params.eventID}`)
       await docPath.update({"guestCount" : admin.firestore.FieldValue.increment(-1)})
   }
)
 
export const onCreateRSVPDoc = functions.firestore.document('/Users/{uid}/RSVP/{eventID}').onCreate(
   async (snapshot, context) => {
       const data = snapshot.data()!
       let timeStamp: admin.firestore.Timestamp = data.startTime!
       let startTime: number = timeStamp!.seconds
 
 
       const project = JSON.parse(process.env.FIREBASE_CONFIG!).projectId
       const location = 'us-central1'
       const queue = 'myq'
      
       const tasksClient = new CloudTasksClient()
       const queuePath: string = tasksClient.queuePath(project, location, queue)
       const url = `https://${location}-${project}.cloudfunctions.net/writeToUserWL`
 
       const eventID = context.params.eventID
       const uid = context.params.uid
       const eventType: string = data.eventType
       const token: string = data.token
       const title: string = data.title
       const payload: SimplePayload = {eventID, uid, eventType, token, title}
       const task = {
           httpRequest: {
               httpMethod: 'POST',
               url,
               body: Buffer.from(JSON.stringify(payload)).toString('base64'),
               headers: {
                   'Content-Type': 'application/json',
               },
           },
           scheduleTime: {
               seconds: startTime
           }
       }
 
       const [response] = await tasksClient.createTask({ parent: queuePath, task })
       const expirationTask = response.name
       const update: EventData = { expirationTask }
       await snapshot.ref.update(update)
   }
)
 
export const onDeleteRSVPDoc = functions.firestore.document('/Users/{uid}/RSVP/{eventID}').onDelete(
   async (snapshot) => {
       const data = snapshot.data()!
 
       const taskForDelete: string = data.expirationTask
  
       if (taskForDelete) {
           const tasksClient = new CloudTasksClient()
           await tasksClient.deleteTask({ name: taskForDelete })
       }else{
           return
       }
   }
)

export const startHeatMap = functions.https.onRequest(async (req, res) => {
const payload = req.body as CampusPayload
    
    const snap = await firestore.collection('Users').where("campus", "==", payload.campus).get()
    
    if (snap.empty) {
        console.log('No matching documents.');
        return;
    }  
    var nilCount: number = 0
    const count: number = snap.docs.length
    
    var arrayOfCoordinates: Coordinate[] = []
    snap.forEach(doc => {
        let data = doc.data()
        const latitude = data.latitude as number | undefined
        const longitude = data.longitude as number | undefined

        

        if (typeof latitude != undefined || typeof longitude != undefined){
            const lon: number = longitude!
            const lat: number = latitude!
            const coordinate: Coordinate = {lon, lat}
            arrayOfCoordinates.push(coordinate)
            if (arrayOfCoordinates.length + nilCount == count){
                console.log("STARTSSTSTSTSTS")
                var forCount = 0
                const coordWMagArray: CoordinateWMag[] = []
                arrayOfCoordinates.forEach(_coordinate => {
                    let targetCoord = _coordinate
                    var secondForCount = 0
                    var magnitude = 0
                    arrayOfCoordinates.forEach(coordinate => {
                        if (targetCoord.lat != coordinate.lat && targetCoord.lon != coordinate.lon) {
                            let distInM = getDistanceFromLatLonInKm(targetCoord.lat, targetCoord.lon, coordinate.lat, coordinate.lon) * 1000
                            if (distInM >= 510){
                                //Do Nothing
                            }else if (distInM >= 150){
                                //Add 5
                                magnitude += 5
                            }else if (distInM >= 90){
                                //Add 6
                                magnitude += 6
                            }else if (distInM >= 40){
                                //Add 7
                                magnitude += 7
                            }

                            secondForCount += 1
                            console.log(secondForCount.toString())
                            if (secondForCount == arrayOfCoordinates.length - 1){
                                forCount += 1
                                console.log(forCount.toString())
                                if (magnitude >= 15){
                                    console.log("Over 15 ")
                                    const lon: number = targetCoord.lon!
                                    const lat: number = targetCoord.lat!
                                    const mag: number = magnitude
                                    const obj: CoordinateWMag = {lon, lat, mag}
                                    coordWMagArray.push(obj)
                                    if (forCount == arrayOfCoordinates.length){
                                        ///MAKE GEOJSON AND STUFF w/ Coord W Magnitude
                                        makeGeoJsonNUpload(payload.campus, coordWMagArray)
                                    }
                                }else{
                                    if (forCount == arrayOfCoordinates.length){
                                        ///MAKE GEOJSON AND STUFF
                                        makeGeoJsonNUpload(payload.campus, coordWMagArray)
                                    }
                                }
                            }
                        }
                    })
                })
            }
        }else{
            nilCount += 1
            console.log('val was undefined I think')
        }
    })
})

function makeGeoJsonNUpload(campus: String, obj: Array<CoordinateWMag>){
    var geojson = {
        "type": "FeatureCollection",
        "crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:OGC:1.3:CRS84" } },
        "features" : [] as any[]
    }

    obj.forEach( coordNMag =>{
        const feature = {
            "type": "Feature",
            "properties": { "id": `${Math.random()}`, "mag": 0, "time": 1507425650893, "felt": null, "tsunami": 0 },
            "geometry": { "type": "Point", "coordinates": [] as any } 
        }
        feature.properties.mag = coordNMag.mag
        feature.geometry.coordinates.push(coordNMag.lon, coordNMag.lat)
        geojson.features.push(feature)
               
        //Append new feature to GEOJSON
        if (geojson.features.length == obj.length){
            ///Push GEOJSON TO STORAGE
            var jsonString = JSON.stringify(geojson);
            console.log(jsonString)

            const storage = admin.storage();

            async function uploadFromMemory() {
                await storage.bucket("bouncer-f8461.appspot.com").file(`${campus}.geojson`)
                .save(jsonString)
                await storage.bucket("bouncer-f8461.appspot.com").file(`${campus}.geojson`)
                .setMetadata({contentType: 'application/octet-stream'})
                console.log(
                    `${campus}.geojson with contents ${jsonString} uploaded to bouncer-f8461.appspot.com.`
                );
            }
            uploadFromMemory().catch(console.error); 
        }
    })
}

function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
    var R = 6371; // Radius of the earth in km
    var dLat = deg2rad(lat2-lat1);  // deg2rad below
    var dLon = deg2rad(lon2-lon1); 
    var a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
      Math.sin(dLon/2) * Math.sin(dLon/2)
      ; 
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    var d = R * c; // Distance in km
    return d;
}
  
function deg2rad(deg: number) {
    return deg * (Math.PI/180)
}

export const deauthInstagram = functions.https.onRequest(async (req, res) =>{
    const payload = req.body
    console.log(payload)
    res.status(200).send("Your account has been successfully deuthorized.")
})

export const deleteInstagramData = functions.https.onRequest(async (req, res) =>{
    const payload = req.body
    console.log(payload)
    res.status(200).send("Your account data has been deleted")
})

export const instagramAuth = functions.https.onRequest(async (req, res) => {
    const payload = req.body
    console.log(req)
    console.log(res)
    console.log(payload)
    res.status(200).send("You have been authenticated w/ instagram.")
})

export const writeToUserWL = functions.https.onRequest(async (req, res) => {
   const payload = req.body as SimplePayload
   try {
       await firestore.collection('Users').doc(payload.uid).collection('RSVP').doc(payload.eventID).delete()
       const userWLDoc = firestore.collection('Users').doc(payload.uid).collection('Waitlisted Events').doc(payload.eventID)
 
       if (payload.eventType == "exclusive"){
           let dataObj = {} as admin.firestore.DocumentData
           var eventID : string = 'eventID'
           dataObj[eventID] = payload.eventID
           await userWLDoc.set(dataObj)
 
           const message = {
               token: payload.token,
               notification: {
                   title: `${payload.title} is now live 😎`,
                   body: "You're now on the waitlist."
               },
               data: {
                   body: "You're now on the waitlist.",
               }
           };
          
           admin.messaging().send(message)
           res.status(200).send('Success')
           return
       }else{
           const message = {
               token: payload.token,
               notification: {
                   title: `${payload.title} is now live 😎`,
                   body: 'Find it on the map'
               },
               data: {
                   body: 'Find it on the map',
               }
           };
          
           admin.messaging().send(message)
           res.status(200).send('Success')
           return
       }
      
 
   }
   catch (error) {
       console.error(error)
        res.status(500).send(error)
        return
   }
})
 
export const onCreateSchedInvDoc = functions.firestore.document('/Users/{uid}/Sched Event Invites/{eventID}').onCreate(
   async (snapshot, context) => {
       const data = snapshot.data()!
       let timeStamp: admin.firestore.Timestamp = data.start_time!
       const startTime: number = timeStamp!.seconds
 
 
       const project = JSON.parse(process.env.FIREBASE_CONFIG!).projectId
       const location = 'us-central1'
       const queue = 'myq'
      
       const tasksClient = new CloudTasksClient()
       const queuePath: string = tasksClient.queuePath(project, location, queue)
       const url = `https://${location}-${project}.cloudfunctions.net/writeToUserEventInvites`
 
       const eventID = context.params.eventID
       const uid = context.params.uid
       const eventType: string = data.eventType
       const token: string = data.token
       const title: string = data.title
       const payload: SimplePayload = {eventID, uid, eventType, token, title, startTime}
       const task = {
           httpRequest: {
               httpMethod: 'POST',
               url,
               body: Buffer.from(JSON.stringify(payload)).toString('base64'),
               headers: {
                   'Content-Type': 'application/json',
               },
           },
           scheduleTime: {
               seconds: startTime
           }
       }
 
       const [response] = await tasksClient.createTask({ parent: queuePath, task })
       const expirationTask = response.name
       const update: EventData = { expirationTask }
       await snapshot.ref.update(update)
   }
)
export const onDeleteSchedInvDoc = functions.firestore.document('/Users/{uid}/Sched Event Invites/{eventID}').onDelete(
   async (snapshot) => {
       const data = snapshot.data()!
 
       const taskForDelete: string = data.expirationTask
  
       if (taskForDelete) {
           const tasksClient = new CloudTasksClient()
           await tasksClient.deleteTask({ name: taskForDelete })
       }else{
           return
       }
   }
)
 
export const writeToUserEventInvites = functions.https.onRequest(async (req, res) => {
   const payload = req.body as SimplePayload
   try {
      
      
       const userWLDoc = firestore.collection('Users').doc(payload.uid).collection('Event Invites').doc(payload.eventID)
 
       if (payload.eventType == "exclusive"){
           let dataObj = {} as admin.firestore.DocumentData
           var timeInvited : string = 'time_invited'
           let number = payload.startTime!
           dataObj[timeInvited] = new admin.firestore.Timestamp(number, 0)
           await userWLDoc.set(dataObj)
 
           const message = {
               token: payload.token,
               notification: {
                   title: `${payload.title} is now live 😎`,
                   body: 'Find this event in your invitations.'
               },
               data: {
                   body: 'Find this event in your invitations.',
               }
           };
          
           admin.messaging().send(message).then(() => {
               res.status(200).send("ok");
             }).catch((err) => {
               res.status(500).send(err);
             });
           await firestore.collection('Users').doc(payload.uid).collection('Sched Event Invites').doc(payload.eventID).delete()
           return
       }
      
 
   }
   catch (error) {
       console.error(error)
        res.status(500).send(error)
        return
   }
})
 
 
 
 
export const onCreateLiveEvent = functions.firestore.document('/Live Events/{state}/{city}/{eventID}').onCreate(
   async (snapshot, context) => {
       const data = snapshot.data()! as EventData
       let expirationAtSeconds: number = data.end_time!.seconds
 
       const project = JSON.parse(process.env.FIREBASE_CONFIG!).projectId
       const location = 'us-central1'
       const queue = 'myq'
 
       const tasksClient = new CloudTasksClient()
       const queuePath: string = tasksClient.queuePath(project, location, queue)
       const url = `https://${location}-${project}.cloudfunctions.net/deleteLiveEvent`
 
       const docPath = snapshot.ref.path
       const state = context.params.state
       const city = context.params.city
       const hostID_array = data.hostID_array
       const venueID = data.venueID
       const title = data.title
       const description = data.description
     
       const image_url = data.image_url
       const price = data.price
       const latitude = data.latitude
       const longitude = data.longitude
       const scene = data.scene
       const start_time = data.start_time
       const end_time = data.end_time
       const type = data.type
       const capacity = data.capacity
       const isHidden = data.isHidden
       const hostDataRef = firestore.collection("Hosts").doc(hostID_array![0]).collection("events").doc(data.venueID!)
       const hostDocPath = hostDataRef.path
       const payload: ExpirationTaskPayload = { docPath, hostDocPath, state, city, hostID_array, venueID, title, description, image_url, price, latitude, longitude, scene, start_time, end_time, type, capacity, isHidden }
 
       const task = {
           httpRequest: {
               httpMethod: 'POST',
               url,
               body: Buffer.from(JSON.stringify(payload)).toString('base64'),
               headers: {
                   'Content-Type': 'application/json',
               },
           },
           scheduleTime: {
               seconds: expirationAtSeconds
           }
       }
 
       const [response] = await tasksClient.createTask({ parent: queuePath, task })
       const expirationTask = response.name
       const update: EventData = { expirationTask }
       await snapshot.ref.update(update)
   }
)
 
export const onCreatePost =
   functions.firestore.document('/Scheduled Events/{state}/{city}/{eventID}').onCreate(
       async (snapshot, context) => {
           const FieldValue = require('firebase-admin').firestore.FieldValue;
           const data = snapshot.data()! as EventData
           const stateDoc = firestore.collection('Scheduled Events').doc(context.params.state)
 
           let dataObj = {} as admin.firestore.DocumentData
           var cityFieldName : string = `${context.params.city}_event_count`
           dataObj[cityFieldName] = FieldValue.increment(1)
           dataObj['event_count'] = FieldValue.increment(1)
           stateDoc.update(dataObj)
          
           let expirationAtSeconds: number = data.start_time!.seconds
 
 
           // Get the project ID from the FIREBASE_CONFIG env var
           const project = JSON.parse(process.env.FIREBASE_CONFIG!).projectId
           const location = 'us-central1'
           const queue = 'myq'
 
           const tasksClient = new CloudTasksClient()
           const queuePath: string = tasksClient.queuePath(project, location, queue)
 
           const url = `https://${location}-${project}.cloudfunctions.net/firestoreTtlCallback`
           const docPath = snapshot.ref.path
           const state = context.params.state
           const city = context.params.city
           const hostID_array = data.hostID_array
           const venueID = data.venueID
           const title = data.title
           const description = data.description
          
           const image_url = data.image_url//..
           const price = data.price //..
           const latitude = data.latitude
           const longitude = data.longitude
           const scene = data.scene
           const start_time = data.start_time
           const end_time = data.end_time//..
           const type = data.type//..
           const capacity = data.capacity//..
           const isHidden = data.isHidden
           const payload: ExpirationTaskPayload = { docPath, state, city, hostID_array, venueID, title, description, image_url, price, latitude, longitude, scene, start_time, end_time, type, capacity, isHidden }
 
           const task = {
               httpRequest: {
                   httpMethod: 'POST',
                   url,
                   body: Buffer.from(JSON.stringify(payload)).toString('base64'),
                   headers: {
                       'Content-Type': 'application/json',
                   },
               },
               scheduleTime: {
                   seconds: expirationAtSeconds
               }
           }
 
           const [response] = await tasksClient.createTask({ parent: queuePath, task })
 
           const expirationTask = response.name
           const update: EventData = { expirationTask }
           await snapshot.ref.update(update)
       })
 
export function updateRSVPCount(before: EventData, after: EventData): number | undefined {
   return after.rsvpIDs?.length
}
 
 
export const firestoreTtlCallback = functions.https.onRequest(async (req, res) => {
   const payload = req.body as ExpirationTaskPayload
   try {
 
       //const liveRef = firestore.collection("Live Events")
      
       const doc = await firestore.doc(payload.docPath).get();
       if (!doc.exists) {
       console.log('No such document!');
       } else {
       const liveEventRef = firestore.collection("Live Events").doc(payload.state).collection(payload.city).doc(payload.venueID!)
       const data = doc.data()
       let invited: [string] = data!.invited
       let rsvps: [string] = data!.rsvpIDs
      
 
      
       let hostID = payload.hostID_array![0]
       const hostDataRef = firestore.collection("Hosts").doc(hostID).collection("events").doc(payload.venueID!)
 
       const hostID_array = payload.hostID_array
       const venueID = payload.venueID //..
       const title = payload.title //..
       const description = payload.description //..
      
       const image_url = payload.image_url//..
       const price = payload.price //..
       const latitude = payload.latitude
       const longitude = payload.longitude
       const scene = payload.scene
       const start_time = new admin.firestore.Timestamp(req.body.start_time._seconds, 0)
       const end_time = new admin.firestore.Timestamp(req.body.end_time._seconds, 0) //..
       const type = payload.type//..
       const capacity = payload.capacity//..
       const isHidden = payload.isHidden
      
      
       const project = JSON.parse(process.env.FIREBASE_CONFIG!).projectId
       const location = 'us-central1'
       const queue = 'myq'
       const tasksClient = new CloudTasksClient()
       const queuePath: string = tasksClient.queuePath(project, location, queue)
       const url = `https://${location}-${project}.cloudfunctions.net/deleteLiveEvent`
 
       const docPath = liveEventRef.path
       const hostDocPath = hostDataRef.path
       const state = ""
       const city = ""
      
       const newPayload : ExpirationTaskPayload = { docPath, hostDocPath, state, city}
 
           const task = {
               httpRequest: {
                   httpMethod: 'POST',
                   url,
                   body: Buffer.from(JSON.stringify(newPayload)).toString('base64'),
                   headers: {
                       'Content-Type': 'application/json',
                   },
               },
               scheduleTime: {
                   seconds: end_time?.seconds
               }
           }
 
           await admin.firestore().doc(payload.docPath).delete()
           const [response] = await tasksClient.createTask({ parent: queuePath, task })
           const expirationTask = response.name
           const data1: EventData = { expirationTask, hostID_array, venueID, title, description, image_url, price, latitude, longitude, scene, start_time, end_time, type, capacity, isHidden }
           const hostData: EventData = { hostID_array, venueID, title, description, image_url, price, latitude, longitude, scene, start_time, end_time, type, capacity, isHidden }
           await liveEventRef.set(data1)
           invited.forEach( id => {
               const invitedCollectionRef = liveEventRef.collection('Invited')
               let dataObj = {} as admin.firestore.DocumentData
               var timeInvited : string = 'time_invited'
               dataObj[timeInvited] = start_time
               invitedCollectionRef.doc(id).set(dataObj)
           });
 
           rsvps.forEach( id => {
               const waitlistCollectionRef = liveEventRef.collection('Waitlist')
               let dataObj = {} as admin.firestore.DocumentData
               var timeJoined: string = 'time_joined'
               dataObj[timeJoined] = start_time
               waitlistCollectionRef.doc(id).set(dataObj)
           });
 
           await hostDataRef.set(hostData)
 
           res.status(200).send("SUCCESS🥸")
           return
       }
   }
   catch (error) {
       console.error(error)
        res.status(500).send(error)
        return
   }
})
 
/**
* DELETES EVENT AT IT'S END TIME (TRIGGERED BY CLOUD TASK)
*/
 
export const deleteLiveEvent = functions.https.onRequest(async (req, res) => {
   const payload = req.body as ExpirationTaskPayload
  
   try{
       const end_time = new admin.firestore.Timestamp(Math.trunc(Date.now()/1000), 0)
       const update = { end_time : end_time }
       await firestore.doc(payload.hostDocPath!).update(update)
       await firestore.doc(payload.docPath).delete()
       // const tasksClient = new CloudTasksClient()
       // await tasksClient.deleteTask({ name: payload })
       res.status(200).send("SUCCESSFULLY DELETED EVENT 😤")
       return
   }
   catch (error) {
       console.error(error)
       res.status(500).send(error)
       return
   }
})
 
 
 
/**
* RECREATES PENDING CLOUD TASK FOR 'START TIME' FIELD CHANGES (TRIGGERED ON DOC UPDATES) && Updates RSVP Count
*/
 
export const onUpdateChangeStartTimeAndOrRsvpCount =
   functions.firestore.document('/Scheduled Events/{state}/{city}/{eventID}').onUpdate(async (change, context) => {
       const before = change.before.data() as EventData
       const after = change.after.data() as EventData
 
       var changeStartTime: boolean | undefined = undefined
 
       // Did the document lose its expiration?
       var expirationTask = after.expirationTask
 
       let oldStartTime = before.start_time
       let newStartTime = after.start_time
 
       if (oldStartTime?.isEqual(newStartTime!)) {
           return
       } else {
           changeStartTime = true
       }
 
 
       if (expirationTask && changeStartTime) {
           const tasksClient = new CloudTasksClient()
           await tasksClient.deleteTask({ name: expirationTask })
 
           const project = JSON.parse(process.env.FIREBASE_CONFIG!).projectId
           const location = 'us-central1'
           const queue = 'myq'
           const queuePath: string = tasksClient.queuePath(project, location, queue)
           const url = `https://${location}-${project}.cloudfunctions.net/firestoreTtlCallback`
 
           const state = context.params.state
           const city = context.params.city
           let eventID = context.params.eventID
           const docPath = `/Scheduled Events/${state}/${city}/${eventID}`
           const hostID_array = after.hostID_array
           const venueID = after.venueID
           const title = after.title
           const description = after.description
           const image_url = after.image_url//..
           const price = after.price //..
           const latitude = after.latitude
           const longitude = after.longitude
           const scene = after.scene
           const start_time = after.start_time
           const end_time = after.end_time//..
           const type = after.type//..
           const capacity = after.capacity//..
           const isHidden = after.isHidden
 
           const payload: ExpirationTaskPayload = { docPath, state, city, hostID_array, venueID, title, description, image_url, price, latitude, longitude, scene, start_time, end_time, type, capacity, isHidden }
           const expirationAtSeconds: number | undefined = after.start_time?.seconds
 
           const task = {
               httpRequest: {
                   httpMethod: 'POST',
                   url,
                   body: Buffer.from(JSON.stringify(payload)).toString('base64'),
                   headers: {
                       'Content-Type': 'application/json',
                   },
               },
               scheduleTime: {
                   seconds: expirationAtSeconds
               }
           }
 
           const [response] = await tasksClient.createTask({ parent: queuePath, task })
 
           expirationTask = response.name
           const rsvpCount = updateRSVPCount(before, after)
           const update: EventData = { expirationTask, rsvpCount }
           await change.before.ref.update(update)
           return
       }else{
           const rsvpCount = updateRSVPCount(before, after)
           const update: EventData = { expirationTask, rsvpCount }
           await change.before.ref.update(update)
           return
       }
   })
 
  
 
   export const onUpdateChangeEndTime =
   functions.firestore.document('/Live Events/{state}/{city}/{eventID}').onUpdate(async (change, context) => {
       const before = change.before.data() as EventData
       const after = change.after.data() as EventData
 
       var changeEndTime: boolean | undefined = undefined
 
       // Did the document lose its expiration?
       var expirationTask = after.expirationTask
 
       let oldEndTime = before.end_time
       let newEndTime = after.end_time
 
       if (oldEndTime?.isEqual(newEndTime!)) {
           return
       } else {
           changeEndTime = true
       }
 
 
       if (expirationTask && changeEndTime) {
           const tasksClient = new CloudTasksClient()
           await tasksClient.deleteTask({ name: expirationTask })
 
           const project = JSON.parse(process.env.FIREBASE_CONFIG!).projectId
           const location = 'us-central1'
           const queue = 'myq'
           const queuePath: string = tasksClient.queuePath(project, location, queue)
           const url = `https://${location}-${project}.cloudfunctions.net/deleteLiveEvent`
 
           const state = context.params.state
           const city = context.params.city
           const eventID = context.params.eventID
           const docPath = `/Live Events/${state}/${city}/${eventID}`
           const hostID_array = after.hostID_array
           const venueID = after.venueID
           const title = after.title
           const description = after.description
           const image_url = after.image_url//..
           const price = after.price //..
           const latitude = after.latitude
           const longitude = after.longitude
           const scene = after.scene
           const start_time = after.start_time
           const end_time = after.end_time//..
           const type = after.type//..
           const capacity = after.capacity//..
           const isHidden = after.isHidden
 
           const payload: ExpirationTaskPayload = { docPath, state, city, hostID_array, venueID, title, description, image_url, price, latitude, longitude, scene, start_time, end_time, type, capacity, isHidden }
           const expirationAtSeconds: number | undefined = after.end_time?.seconds
 
           const task = {
               httpRequest: {
                   httpMethod: 'POST',
                   url,
                   body: Buffer.from(JSON.stringify(payload)).toString('base64'),
                   headers: {
                       'Content-Type': 'application/json',
                   },
               },
               scheduleTime: {
                   seconds: expirationAtSeconds
               }
           }
 
           const [response] = await tasksClient.createTask({ parent: queuePath, task })
 
           expirationTask = response.name
           const update: EventData = { expirationTask }
           await change.before.ref.update(update)
           return
       }
   })
 
/**
* CLEANS UP PENDING TASKS ON USER SCHEDULED EVENT DELETION
*/
export const onUpdateScheduleEventCancel =
   functions.firestore.document('/Scheduled Events/{state}/{city}/{eventID}').onDelete(async (snap, context) => {
       const data = snap.data() as EventData
       const taskForDelete = data.expirationTask
       const FieldValue = require('firebase-admin').firestore.FieldValue;
       const stateDoc = firestore.collection('Scheduled Events').doc(context.params.state)
 
           let dataObj = {} as admin.firestore.DocumentData
           var cityFieldName : string = `${context.params.city}_event_count`
           dataObj[cityFieldName] = FieldValue.increment(-1)
           dataObj['event_count'] = FieldValue.increment(-1)
           stateDoc.update(dataObj)
      
       if (taskForDelete) {
           const tasksClient = new CloudTasksClient()
           await tasksClient.deleteTask({ name: taskForDelete })
       }else{
           return
       }
   })
 
/**
* CLEANS UP PENDING TASKS ON USER LIVE EVENT DELETION
*/
export const onUpdateLiveEventCancel =
functions.firestore.document('/Live Events/{state}/{city}/{eventID}').onDelete(async snap => {
   const data = snap.data() as EventData
   const taskForDelete = data.expirationTask
  
   if (taskForDelete) {
       const tasksClient = new CloudTasksClient()
       await tasksClient.deleteTask({ name: taskForDelete })
   }else{
       return
   }
})

export const increaseCampusUserCount = 
functions.firestore.document('/Users/{uid}').onCreate(async (snap) => {
    const userData = snap.data() 
    let campus_name = userData.campus
    let campusDoc = firestore.doc(`/Campuses/${campus_name}/`)
    let dataObj = {} as admin.firestore.DocumentData
    const FieldValue = require('firebase-admin').firestore.FieldValue;
    dataObj['user_count'] = FieldValue.increment(1)
    return campusDoc.update(dataObj)
})

export const decreaseCampusUserCount = 
functions.firestore.document('/Users/{uid}').onDelete(async (snap) => {
    const userData = snap.data() 
    let campus_name = userData.campus
    let campusDoc = firestore.doc(`/Campuses/${campus_name}/`)
    let dataObj = {} as admin.firestore.DocumentData
    const FieldValue = require('firebase-admin').firestore.FieldValue;
    dataObj['user_count'] = FieldValue.increment(-1)
    return campusDoc.update(dataObj)
})



export const onAuthDelete = 
functions.auth.user().onDelete(async (user) => {
    const uid = user.uid
    return firestore.doc(`/Users/${uid}/`).delete()
})

