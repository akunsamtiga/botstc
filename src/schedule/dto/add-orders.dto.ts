import { IsString, IsNotEmpty } from 'class-validator';

export class AddOrdersDto {
  @IsString()
  @IsNotEmpty({ message: 'Input tidak boleh kosong' })
  input: string;
}