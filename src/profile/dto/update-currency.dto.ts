import { IsString, IsNotEmpty, Length } from 'class-validator';

export class UpdateCurrencyDto {
  @IsString()
  @IsNotEmpty()
  @Length(2, 5)
  currencyIso: string;
}
