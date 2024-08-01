/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/record', 'N/log', 'N/error', 'N/search', 'N/email', 'N/runtime'], function (record, log, error, search, email, runtime) {



    function post(body) {
        try {
            log.debug('Starting POST request processing', 'Body received: ' + JSON.stringify(body));
            var nscustomerId = 0;
            var requestBody = body;
            var result = {};

            if (requestBody) {
                var orderId = requestBody.id ? requestBody.id : '';
                log.debug('Order ID', orderId);

                if (orderId) {
                    var findOrderInNS = searchOrderInNS(orderId);
                    log.debug('Order found in NetSuite', findOrderInNS);

                    if (!findOrderInNS) {
                        var customerDisName = requestBody.DistributorName;

                        var nsDisCustomerId = findCustomerInNS(customerDisName);
                        log.debug('NetSuite Distributor Customer ID', nsDisCustomerId);

                        if (nsDisCustomerId || customerDisName == 'EZ ON THE EARTH - HOUSE') {
                            var customerName = requestBody.CustomerName;
                            log.debug('Customer Name', customerName);

                            var nsCustomerExists = checkSubCustomerExists(nsDisCustomerId, customerName);
                            log.debug('NetSuite Customer exists id', nsCustomerExists);

                            let invoiceid = 0
                            if (nsCustomerExists) {
                                log.debug('Customer found in NetSuite', nsCustomerExists);
                                nscustomerId = nsCustomerExists
                                var nsCustomerAddressId = findCustomerOnAddressInNS(nscustomerId, requestBody);
                                log.debug("nsCustomerAddressId id", nsCustomerAddressId);
                                if (!nsCustomerAddressId) {
                                    log.debug('Customer address not found', 'Updating address for customer ID: ' + nscustomerId);
                                    var customerRecord = record.load({
                                        type: record.Type.CUSTOMER,
                                        id: nscustomerId,
                                        isDynamic: true
                                    });
                                    updateAddressBook(customerRecord, requestBody);
                                    log.debug('Customer address updated', 'Creating invoice for customer ID: ' + nscustomerId);
                                    invoiceid = createInvoiceWithPayment(nscustomerId, orderId, requestBody);
                                    result = { success: 'Customer address and invoice processed successfully.' + invoiceid };
                                }else{
                                    invoiceid = createInvoiceWithPayment(nscustomerId, orderId, requestBody);
                                    result = { success: 'New customer created and invoice processed successfully.' + JSON.stringify(invoiceid) };
                                }
                            } else {
                                log.debug('Customer not found in NetSuite', 'Creating new customer with parent ID: ' + nsDisCustomerId);
                                var newCustomerId = createCustomer(nsDisCustomerId, requestBody);
                                log.debug('New customer created', 'New Customer ID: ' + newCustomerId);
                                invoiceid = createInvoiceWithPayment(newCustomerId, orderId, requestBody);
                                result = { success: 'New customer created and invoice processed successfully.' + JSON.stringify(invoiceid) };
                            }
                        } else {
                            log.debug('Distributor not found in NetSuite', 'Sending email notification');
                            var currentUserId = runtime.getCurrentUser().id;
                            var currentUserEmail = runtime.getCurrentUser().email;
                            var emailBody = 'The following order has failed because the distributor is not found in NetSuite.\n\n' +
                                'Order Id: ' + orderId + '\n' +
                                'Distributor Name: ' + customerDisName + '\n';

                            email.send({
                                author: 102807,
                                recipients: ['rohail.khan@lightingresourcesinc.com', 'hassan.raja@lightingresourcesinc.com'],//['adeel.afzal@lightingresourcesinc.com'],
                                cc: ['adeel.afzal@lightingresourcesinc.com'], //[currentUserEmail],
                                subject: 'Failed to Create OMS Order in NetSuite',
                                body: emailBody
                            });

                            result = {
                                error: 'Distributor not found. Email notification sent.'
                            };
                        }
                    } else {
                        log.debug('Order already exists', 'Invoice for order ID: ' + orderId + ' already exists in NetSuite');
                        result = {
                            error: 'Invoice already exists in NetSuite'
                        };
                    }
                } else {
                    log.debug('Order ID not provided', 'Order ID is missing in the request body');
                    result = {
                        error: 'Order ID not provided'
                    };
                }
            } else {
                log.debug('Request body not found', 'The request body is missing or malformed');
                result = {
                    error: 'Request body not found'
                };
            }

            log.debug('POST request processing completed', 'Result: ' + JSON.stringify(result));
            return result;

        } catch (e) {
            log.error({
                title: 'Error in POST request processing',
                details: e.toString()
            });
            return { error: e.message };
        }
    }
    function checkSubCustomerExists(parentCustomerId, customerName) {
        var filtersArray = [];
        if (parentCustomerId) {
            filtersArray.push(['parent', 'is', parentCustomerId]);
        }
        var customerSearch = search.create({
            type: 'customer',
            filters: filtersArray,/*[
                ['parent', 'is', parentCustomerId]
            ],*/
            columns: [
                'internalid', 'companyname'
            ]
        });

        var resultSet = customerSearch.run();
        var results = resultSet.getRange({
            start: 0,
            end: 1000
        });

        var subCustomers = results.map(function (result) {
            return {
                id: result.getValue('internalid'),
                name: result.getValue('companyname')
            };
        });

        log.debug("Total Subcustomers Found", subCustomers.length);

        var foundCustomer = subCustomers.filter(function (customer) {
            // log.debug("customer",customer);
            return customer.name === customerName;
        });

        if (foundCustomer.length > 0) {
            log.debug('Subcustomer Found', 'ID: ' + foundCustomer[0].id + ', Name: ' + customerName);
            return foundCustomer[0].id;
        } else {
            log.debug('Subcustomer Not Found', customerName);
            return false;
        }
    }



    /**
     * Paginator function to handle search results.
     * @param {Object} searchObj - The search object.
     * @param {number} pageSize - Number of results per page.
     * @returns {Iterator} - An iterator for paged results.
     */
    function* getPagedResults(searchObj, pageSize) {
        let start = 0;
        let end = pageSize;
        let searchResult;

        do {
            searchResult = searchObj.run().getRange({ start, end });
            yield searchResult;
            start += pageSize;
            end += pageSize;
        } while (searchResult.length > 0);
    }

    function searchOrderInNS(orderId) {
        var invoiceSearchObj = search.create({
             type: "invoice",
             filters:
                 [
                     ["mainline", "is", "T"],
                     "AND",
                     ["type", "anyof", "CustInvc"],
                     "AND",
                     //["custbody_order_id", "is", orderId]
                     ["poastext", "is", orderId]
                 ],
             columns:
                 [
                     search.createColumn({ name: "tranid", label: "Document Number" })
                 ]
         });
         var searchResultCount = invoiceSearchObj.runPaged().count;
         log.debug("invoiceSearchObj result count", searchResultCount);
         if (searchResultCount > 0) {
             return true;
         } else {
             return false;
         }
        //return true;
    }

    /**
  * @param {string} customerName - The name of the customer to search for.
  */
    function findCustomerInNS(customerName) {
        var internalId = '';
        try {
            var customerSearchObj = search.create({
                type: "customer",
                filters: [
                    ["entityid", "is", customerName]
                ],
                columns: [
                    search.createColumn({ name: "internalid", label: "Internal ID" }),
                    search.createColumn({ name: "entityid", label: "Name" })
                ]
            });
            var searchResultCount = customerSearchObj.runPaged().count;
            log.debug("customerSearchObj result count", searchResultCount);

            if (searchResultCount === 1) {
                var searchResults = customerSearchObj.run().getRange({ start: 0, end: 1 });
                internalId = searchResults[0].getValue({ name: "internalid" });
            }
        } catch (error) {
            log.error({
                title: 'Error in findCustomerInNS',
                details: error.toString()
            });
        }
        return internalId;
    }

    /**
 * Searches for a specific address for a given customer and returns the address internal ID if found.
 * @param {string} nsCustomerId - The internal ID of the customer.
 * @param {string} addr1 - The first line of the address.
 * @param {string} addr2 - The second line of the address (optional).
 * @param {string} city - The city of the address.
 * @param {string} state - The state of the address.
 * @param {string} zip - The ZIP code of the address.
 * @param {string} country - The country of the address.
 * @returns {string} addressId - The internal ID of the address or an empty string if no match is found.
 */
    function findCustomerOnAddressInNS(nscustomerId, requestBody) {

        var addr1 = requestBody.Address1;
        var addr2 = requestBody.Address2;
        var city = requestBody.City;
        var state = requestBody.State;
        var zip = requestBody.Zip;
        var country = requestBody.Country ? requestBody.Country : 'USA';
        var addressId = '';
        try {
            var filtersArray = [];
            if (nscustomerId) {
                filtersArray.push(["internalid", "anyof", nscustomerId]);
            }
            if (addr1) {
                filtersArray.push("AND");
                filtersArray.push(["address.address1", "is", addr1]);
            }
            if (addr2 && false) {
                filtersArray.push("AND");
                filtersArray.push(["address.address2", "is", addr2]);
            }
            if (city) {
                filtersArray.push("AND");
                filtersArray.push(["address.city", "is", city]);
            }
            // if (state) {
            //     filtersArray.push("AND");
            //     filtersArray.push(["address.stateid", "anyof", state]);
            // }
            if (zip) {
                filtersArray.push("AND");
                filtersArray.push(["address.zipcode", "is", zip]);
            }
            if (country && false) {
                filtersArray.push("AND");
                filtersArray.push(["address.country", "anyof", country]);
            }

            if (filtersArray.length > 0) {
                var customerSearchObj = search.create({
                    type: "customer",
                    filters: filtersArray,
                    columns: [
                        search.createColumn({ name: "internalid", label: "Internal Id" }),
                        search.createColumn({ name: "entityid", label: "Name" }),
                        search.createColumn({ name: "internalid", join: "Address", label: "Internal ID" })
                    ]
                });
                var searchResults = customerSearchObj.run().getRange({ start: 0, end: 1 });
                if (searchResults.length > 0) {
                    addressId = searchResults[0].getValue({ name: "internalid", join: "Address" });
                }
            }
        } catch (error) {
            log.error({
                title: 'Error in findCustomerOnAddressInNS',
                details: error.toString()
            });
        }
        return addressId;
    }

    function findSKUInternalId(sku) {
        var itemSearchObj = search.create({
            type: "item",
            filters:
                [
                    ["name", "is", sku]
                ],
            columns:
                [
                    search.createColumn({ name: "internalid", label: "Internal ID" })
                ]
        });
        var searchResultCount = itemSearchObj.runPaged().count;
        log.debug('searchResultCount', searchResultCount);
        var searchResults = itemSearchObj.run().getRange({ start: 0, end: 1 });
        var internalId = '';
        for (var k = 0; k < searchResults.length; k++) {
            internalId = searchResults[k].getValue({ name: "internalid" });
        }
        return internalId;
    }

    function createInvoiceWithPayment(nsCustomerId, orderId, requestBody) {
        try {
            log.debug('requestBody', requestBody);

            // Create the invoice record
            var invoiceRecord = record.create({
                type: record.Type.INVOICE,
                isDynamic: true,
            });

            invoiceRecord.setValue({
                fieldId: 'entity',
                value: nsCustomerId,
            });
            invoiceRecord.setValue({
                fieldId: 'custbody_order_id',
                value: orderId,
            });
            invoiceRecord.setValue({
                fieldId: 'otherrefnum',
                value: orderId//requestBody.CustomerPONumber || '',
            });
            invoiceRecord.setValue({
                fieldId: 'location',
                value: '2'//requestBody.location,
            });

            // if (billaddresslist) {
            //     invoiceRecord.setValue({
            //         fieldId: 'billaddresslist',
            //         value: billaddresslist,
            //     });
            // }

            // Iterate through order items and add them to the invoice
            var orderItems = requestBody.OrderItems;
            log.debug('orderItems', orderItems);

            for (var i = 0; i < orderItems.length; i++) {
                var itemObj = orderItems[i];
                log.debug('itemObj', itemObj)
                invoiceRecord.selectNewLine({
                    sublistId: 'item'
                });
                var itemInternalId = findSKUInternalId(itemObj.ItemNumber);
                invoiceRecord.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    value: itemInternalId//itemObj.ItemNumber
                });
                invoiceRecord.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    value: itemObj.Quantity,
                });
                invoiceRecord.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'rate',
                    value: itemObj.UnitPrice,
                });
                invoiceRecord.commitLine({ sublistId: 'item' });
            }

            // Save the invoice
            var invoiceId = invoiceRecord.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });
            log.debug('Invoice Created', 'ID: ' + invoiceId);

            // Create customer payment for the invoice
            var customerPaymentRecord = record.transform({
                fromType: record.Type.INVOICE,
                fromId: invoiceId,
                toType: record.Type.CUSTOMER_PAYMENT
            });

            var customerPaymentId = customerPaymentRecord.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });
            log.debug('Customer Payment Created', 'ID: ' + customerPaymentId);

            return {
                invoiceInternalId: invoiceId,
                paymentInternalId: customerPaymentId
            };

        } catch (error) {
            log.error({
                title: 'Error creating invoice or customer payment',
                details: error
            });
            return {
                status: 'error',
                message: error.message
            };
        }
    }


    /**
       * Creates a new child customer record under a specified parent customer.
       * @param {string} parentCustomerId - The internal ID of the parent customer.
       * @param {Object} requestBody - An object containing details for the new child customer.
       * @returns {string|Object} - The internal ID of the newly created customer, or an error object.
       */
    function createCustomer(parentCustomerId, requestBody) {
        try {
            var customerRecord = record.create({
                type: 'customer',
                isDynamic: true
            });

            customerRecord.setValue({
                fieldId: 'companyname',
                value: requestBody.CustomerName
            });
            customerRecord.setValue({
                fieldId: 'parent',
                value: parentCustomerId
            });
            //Business Unit is mandatory field in Customer Record
            customerRecord.setValue({
                fieldId: 'custentity_lrbusinessunit',
                value: 1
            });

            if (requestBody.Email) {
                if (isValidEmail(requestBody.Email)) {
                    customerRecord.setValue({
                        fieldId: 'email',
                        value: requestBody.Email
                    });
                } else {
                    throw new Error("Invalid email format.");
                }
            }

            if (requestBody.Phone) {
                if (requestBody.Phone.length >= 7) {
                    customerRecord.setValue({
                        fieldId: 'phone',
                        value: requestBody.Phone
                    });
                } else {
                    throw new Error("Phone number should have seven digits or more.");
                }
            }

            customerRecord.setValue({
                fieldId: 'subsidiary',
                value: 1
            });

            var customerId = updateAddressBook(customerRecord, requestBody);

            /*var customerId = customerRecord.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });*/

            return customerId;
        } catch (err) {
            log.debug({
                title: 'Error in createCustomer',
                details: err.message
            });
            throw err; // rethrow the error to handle it in the calling function
        }
    }

    function updateAddressBook(customerRecord, requestBody) {
        try {
            var addr1 = requestBody.Address1;
            var addr2 = requestBody.Address2;
            var city = requestBody.City;
            var state = requestBody.State;
            var zip = requestBody.Zip;
            var country = requestBody.Country || 'United States'; // Default to 'USA' if no country provided

            customerRecord.selectNewLine({ sublistId: 'addressbook' });

            customerRecord.setCurrentSublistValue({
                sublistId: 'addressbook',
                fieldId: 'defaultbilling',
                value: true
            });

            customerRecord.setCurrentSublistValue({
                sublistId: 'addressbook',
                fieldId: 'defaultshipping',
                value: true
            });

            customerRecord.setCurrentSublistValue({
                sublistId: 'addressbook',
                fieldId: 'label',
                value: 'Default Address'
            });

            var addressSubrecord = customerRecord.getCurrentSublistSubrecord({
                sublistId: 'addressbook',
                fieldId: 'addressbookaddress'
            });

            addressSubrecord.setValue({ fieldId: 'addr1', value: addr1 });
            addressSubrecord.setValue({ fieldId: 'addr2', value: addr2 });
            addressSubrecord.setValue({ fieldId: 'city', value: city });
            addressSubrecord.setValue({ fieldId: 'state', value: state });
            addressSubrecord.setValue({ fieldId: 'zip', value: zip });
            addressSubrecord.setText({ fieldId: 'country', text: country });

            customerRecord.commitLine({ sublistId: 'addressbook' });

            // Save the customer record to apply changes
            var recordId = customerRecord.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.debug('Address Book Updated', 'Customer address book updated successfully with record ID: ' + recordId);
        } catch (e) {
            log.error('Error Updating Address Book', e.toString());
            throw e; // Optionally re-throw the error after logging it
        }
    }



    function isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }



    return {
        post: post
    };

});
