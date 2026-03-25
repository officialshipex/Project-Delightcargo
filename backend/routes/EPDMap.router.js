const express = require('express');
const router = express.Router();
const epdController = require('../Orders/EPDMap.controller');

router.get('/maps', epdController.getAllEpdMap);
router.post('/add', epdController.addEPD);
router.put('/update/:id', epdController.updateEPD);
router.delete('/delete/:id', epdController.deleteEPD);

module.exports = router;
