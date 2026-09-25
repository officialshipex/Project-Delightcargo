
const AmazonStatusMapping = {
  "readyforreceive": "Ready To Ship",
  "pickupdone": "In-transit",
  "arrivedatcarrierfacility": "In-transit",
  "outfordelivery": "Out for Delivery",
  "departed": "In-transit",
  "delivered": "Delivered",
  "deliveryattempted": "Undelivered",
  "undelivered": "Undelivered",
  "pickupcancelled": "Cancelled"
};

module.exports = AmazonStatusMapping;
