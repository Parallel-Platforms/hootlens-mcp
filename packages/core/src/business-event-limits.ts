export const BUSINESS_EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const BUSINESS_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const MAX_BUSINESS_EVENTS_PER_BATCH = 20;
export const MAX_CONVERSION_AMOUNT_MINOR = 1_000_000_000;
export const SUPPORTED_CONVERSION_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'INR', 'BRL', 'MXN', 'SGD', 'ZAR', 'KWD', 'BHD', 'OMR', 'KRW', 'AED', 'SAR', 'CNY', 'HKD', 'PLN', 'CZK', 'HUF', 'ILS', 'TRY', 'THB', 'MYR', 'PHP', 'IDR'] as const;
export type ConversionCurrency = typeof SUPPORTED_CONVERSION_CURRENCIES[number];
